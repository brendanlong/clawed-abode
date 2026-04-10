/**
 * Shutdown hook execution service.
 *
 * Runs a final Claude prompt when a session is archived, with the full
 * conversation context (via resume). The hook's messages appear in the
 * archived session, collapsed by default behind a separator.
 */

import { v4 as uuid } from 'uuid';
import { prisma } from '@/lib/prisma';
import { extractRepoFullName } from '@/lib/utils';
import { runClaudeCommand, createErrorMessage } from './claude-runner';
import { loadMergedSessionSettings } from './settings-merger';
import { getSessionWorkingDir } from './worktree-manager';
import { removeWorkspace } from './worktree-manager';
import { sseEvents } from './events';
import { createLogger, toError } from '@/lib/logger';

const log = createLogger('shutdown-hooks');

interface SessionForHook {
  id: string;
  name: string;
  repoUrl: string | null;
  branch: string | null;
  repoPath: string;
}

/**
 * Expand template variables in a shutdown hook prompt.
 * Pure function — easily unit testable.
 */
export function expandHookTemplate(template: string, session: SessionForHook): string {
  const repoFullName = session.repoUrl ? extractRepoFullName(session.repoUrl) : 'No Repository';
  const date = new Date().toISOString().split('T')[0];

  return template
    .replace(/\{\{session\.name\}\}/g, session.name)
    .replace(/\{\{session\.repo\}\}/g, repoFullName)
    .replace(/\{\{session\.branch\}\}/g, session.branch ?? '')
    .replace(/\{\{date\}\}/g, date);
}

/**
 * Insert a system message marking the start of shutdown hook output.
 * This separator is used by the UI to collapse hook messages by default.
 */
async function insertHookSeparatorMessage(sessionId: string): Promise<void> {
  const lastMessage = await prisma.message.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });

  const sequence = (lastMessage?.sequence ?? -1) + 1;

  const content = {
    type: 'system',
    subtype: 'shutdown_hook_separator',
  };

  const message = await prisma.message.create({
    data: {
      id: uuid(),
      sessionId,
      sequence,
      type: 'system',
      content: JSON.stringify(content),
    },
  });

  sseEvents.emitNewMessage(sessionId, {
    id: message.id,
    sessionId,
    sequence,
    type: 'system',
    content,
    createdAt: message.createdAt,
  });
}

/**
 * Run the shutdown hook for a session, then finalize archiving.
 *
 * This function should be called in the background (not awaited in the
 * request handler). It:
 * 1. Inserts a separator message
 * 2. Runs the hook prompt with full session context (resume)
 * 3. Removes the workspace
 * 4. Sets the session to archived
 *
 * If the hook fails or is interrupted, archiving still completes.
 */
export async function runShutdownHook(session: SessionForHook, hookPrompt: string): Promise<void> {
  const { id: sessionId } = session;

  try {
    // Insert separator before hook messages
    await insertHookSeparatorMessage(sessionId);

    // Expand template variables
    const expandedPrompt = expandHookTemplate(hookPrompt, session);

    // Load merged settings (same as claude.send)
    const repoFullName = session.repoUrl ? extractRepoFullName(session.repoUrl) : null;
    const settingsKey = repoFullName ?? '__no_repo__';
    const settings = await loadMergedSessionSettings(settingsKey);

    // Build working directory
    const workingDir = getSessionWorkingDir(sessionId, session.repoPath);

    log.info('Running shutdown hook', { sessionId, promptLength: expandedPrompt.length });

    // Run the hook prompt — this awaits until Claude finishes or is interrupted
    await runClaudeCommand({
      sessionId,
      prompt: expandedPrompt,
      workingDir,
      customSystemPrompt: settings.customSystemPrompt,
      globalSettings: settings.globalSettings,
      claudeModel: settings.claudeModel,
      mcpServers: settings.mcpServers,
    });

    log.info('Shutdown hook completed', { sessionId });
  } catch (err) {
    log.error('Shutdown hook failed', toError(err), { sessionId });
    try {
      await createErrorMessage(sessionId, `Shutdown hook failed: ${toError(err).message}`);
    } catch (msgErr) {
      log.error('Failed to create error message for shutdown hook failure', toError(msgErr), {
        sessionId,
      });
    }
  }

  // Always finalize archiving, even if hook failed or was interrupted
  try {
    await removeWorkspace(sessionId);

    const updatedSession = await prisma.session.update({
      where: { id: sessionId },
      data: {
        status: 'archived',
        archivedAt: new Date(),
        statusMessage: null,
      },
    });

    sseEvents.emitSessionUpdate(sessionId, updatedSession);
    log.info('Session archived after shutdown hook', { sessionId });
  } catch (err) {
    log.error('Failed to finalize archiving after shutdown hook', toError(err), { sessionId });
  }
}
