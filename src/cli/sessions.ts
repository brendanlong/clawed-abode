/**
 * Session orchestration for the abode CLI.
 *
 * Sessions share the database (and lifecycle semantics) with the web app, but
 * instead of in-process Agent SDK queries each session is an interactive
 * Claude Code TUI running in a dedicated tmux session. This keeps usage in
 * the subscription-billed interactive pool.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import type { Session } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { extractRepoFullName } from '@/lib/utils';
import { NO_REPO_SENTINEL } from '@/lib/types';
import {
  cloneRepo,
  createEmptyWorkspace,
  removeWorkspace,
  getSessionWorkspacePath,
  getSessionWorkingDir,
} from '@/server/services/worktree-manager';
import { loadMergedSessionSettings } from '@/server/services/settings-merger';
import { buildClaudeArgs, buildMcpConfig, buildSessionEnvVars } from './claude-command';
import {
  tmuxSessionName,
  createTmuxSession,
  hasTmuxSession,
  killTmuxSession,
  attachTmuxSession,
  listTmuxSessions,
} from './tmux';

export interface CliSession extends Session {
  /** Whether a live tmux session backs this session right now */
  tmuxAlive: boolean;
}

/**
 * List sessions with tmux liveness, newest activity first.
 */
export async function listCliSessions(options?: { archived?: boolean }): Promise<CliSession[]> {
  const [sessions, liveTmux] = await Promise.all([
    prisma.session.findMany({
      where: options?.archived ? { status: 'archived' } : { status: { not: 'archived' } },
      orderBy: { updatedAt: 'desc' },
    }),
    listTmuxSessions(),
  ]);

  return sessions.map((session) => ({
    ...session,
    tmuxAlive: liveTmux.has(tmuxSessionName(session.id)),
  }));
}

/**
 * Launch the interactive Claude Code TUI for a session in a detached tmux
 * session, with all settings (model, system prompt, env vars, MCP servers)
 * assembled from the database.
 */
export async function launchClaudeInTmux(
  session: Session,
  options: { resume: boolean; initialPrompt?: string }
): Promise<void> {
  const repoFullName = session.repoUrl ? extractRepoFullName(session.repoUrl) : null;
  const settings = await loadMergedSessionSettings(repoFullName ?? NO_REPO_SENTINEL);

  // The MCP config lives in the workspace dir (sibling of the repo clone),
  // never inside the repo itself.
  let mcpConfigPath: string | undefined;
  const mcpConfig = buildMcpConfig(settings.mcpServers);
  if (mcpConfig) {
    mcpConfigPath = join(getSessionWorkspacePath(session.id), 'abode-mcp.json');
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
  }

  const args = buildClaudeArgs({
    sessionId: session.id,
    resume: options.resume,
    model: settings.claudeModel,
    systemPromptAppend: settings.systemPrompt,
    mcpConfigPath,
    initialPrompt: options.initialPrompt,
  });

  // Override when claude isn't on the tmux login shell's PATH (or in tests)
  const claudeBin = process.env.ABODE_CLAUDE_BIN ?? 'claude';

  await createTmuxSession({
    name: tmuxSessionName(session.id),
    cwd: getSessionWorkingDir(session.id, session.repoPath),
    env: buildSessionEnvVars(settings.envVars, settings.claudeApiKey),
    command: [claudeBin, ...args],
  });
}

export interface CreateCliSessionOptions {
  name: string;
  repoFullName?: string;
  branch?: string;
  initialPrompt?: string;
  /** Progress callback for the hub UI */
  onProgress?: (message: string) => void;
}

/**
 * Create a session: DB row, workspace (clone for repo sessions), and the
 * tmux-hosted Claude TUI. Returns the running session.
 */
export async function createCliSession(options: CreateCliSessionOptions): Promise<Session> {
  const hasRepo = !!options.repoFullName && !!options.branch;
  const progress = options.onProgress ?? (() => {});

  const session = await prisma.session.create({
    data: {
      name: options.name,
      repoUrl: hasRepo ? `https://github.com/${options.repoFullName}.git` : null,
      branch: hasRepo ? options.branch! : null,
      workspacePath: '',
      status: 'creating',
      initialPrompt: options.initialPrompt,
    },
  });

  try {
    let repoPath = '';
    if (hasRepo) {
      progress(`Cloning ${options.repoFullName} (${options.branch})...`);
      const result = await cloneRepo({
        sessionId: session.id,
        repoFullName: options.repoFullName!,
        branch: options.branch!,
        githubToken: env.GITHUB_TOKEN,
      });
      repoPath = result.repoPath;
    } else {
      progress('Creating workspace...');
      await createEmptyWorkspace(session.id);
    }

    progress('Starting Claude Code...');
    const updated = await prisma.session.update({
      where: { id: session.id },
      data: {
        repoPath,
        workspacePath: getSessionWorkspacePath(session.id),
        status: 'running',
        statusMessage: null,
      },
    });

    await launchClaudeInTmux(updated, { resume: false, initialPrompt: options.initialPrompt });
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create session';
    await prisma.session.update({
      where: { id: session.id },
      data: { status: 'error', statusMessage: message },
    });
    throw error;
  }
}

/**
 * Attach the current terminal to a session's tmux session, relaunching
 * Claude with --resume first if the tmux session is gone (server restart,
 * user exited Claude, etc.). Blocks until the user detaches or Claude exits.
 *
 * Returns whether the tmux session is still alive after detach.
 */
export async function attachCliSession(session: Session): Promise<{ stillRunning: boolean }> {
  const name = tmuxSessionName(session.id);

  if (!(await hasTmuxSession(name))) {
    // Resume the existing Claude conversation unless the session never got
    // past creation (no conversation to resume yet).
    await launchClaudeInTmux(session, { resume: session.status !== 'creating' });
  }

  await prisma.session.update({
    where: { id: session.id },
    data: { status: 'running', statusMessage: null },
  });

  attachTmuxSession(name);

  return { stillRunning: await hasTmuxSession(name) };
}

/**
 * Stop a session's Claude process (kill the tmux session) but keep the
 * workspace and DB record so it can be resumed later.
 */
export async function stopCliSession(session: Session): Promise<void> {
  await killTmuxSession(tmuxSessionName(session.id));
  await prisma.session.update({
    where: { id: session.id },
    data: { status: 'stopped' },
  });
}

/**
 * Stop a session and archive it: kill tmux, remove the workspace, and mark
 * the DB record archived (same semantics as the web app's delete flow).
 */
export async function archiveCliSession(session: Session): Promise<void> {
  await killTmuxSession(tmuxSessionName(session.id));
  await removeWorkspace(session.id);
  await prisma.session.update({
    where: { id: session.id },
    data: { status: 'archived', archivedAt: new Date() },
  });
}
