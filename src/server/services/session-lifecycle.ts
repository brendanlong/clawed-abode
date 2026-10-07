/** Session lifecycle and the API's writes to a session row; status writes go through `transitionSession`. */

import { TRPCError } from '@trpc/server';
import { prisma } from '@/lib/prisma';
import { createLogger, toError } from '@/lib/logger';
import { ALLOWED_FROM, type SessionTransition } from '@/lib/session-transitions';
import type { Prisma, Session } from '@/generated/prisma/client';
import { sseEvents } from './events';
import { cloneRepo, createEmptyWorkspace, removeWorkspace } from './worktree-manager';
import {
  cleanupSession,
  isClaudeRunning,
  refreshSessionSettings,
  reviveSession,
  sendUserMessage,
  stopSession,
} from './claude-runner';
import { resolveAgentName } from './agent-name';
import { clearQueuedPrompts } from './prompt-queue';
import { recomputeRateLimitHolds } from './rate-limit-pause';
import type { SessionToolsPort } from './builtin-mcp';

const log = createLogger('session-lifecycle');

/** Write non-status fields and push the new row to subscribers. */
export async function updateSession(
  sessionId: string,
  data: Omit<Prisma.SessionUpdateInput, 'status'>
): Promise<Session> {
  const session = await prisma.session.update({ where: { id: sessionId }, data });
  sseEvents.emitSessionUpdate(sessionId, session);
  return session;
}

interface TransitionResult {
  /** False when the row wasn't in an allowed status; `session` is then the unchanged current row. */
  applied: boolean;
  session: Session;
}

/**
 * Apply `data` only if the session's status is one `transition` may leave, in a
 * single statement, and emit the update when it applied.
 */
async function transitionSession(
  sessionId: string,
  transition: SessionTransition,
  data: Prisma.SessionUpdateManyMutationInput
): Promise<TransitionResult> {
  const [updated] = await prisma.session.updateManyAndReturn({
    where: { id: sessionId, status: { in: [...ALLOWED_FROM[transition]] } },
    data,
  });
  if (updated) {
    sseEvents.emitSessionUpdate(sessionId, updated);
    return { applied: true, session: updated };
  }
  const current = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!current) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }
  return { applied: false, session: current };
}

interface CreateSessionInput {
  name: string;
  repoFullName?: string;
  branch?: string;
  initialPrompt?: string;
  claudeModel?: string;
  /** Set when another session's agent creates this one (see `sessionBuiltinTools`). */
  createdBySessionId?: string;
}

/**
 * Insert the row in `creating` and start setup in the background, so the caller
 * returns immediately; progress arrives over SSE.
 */
export async function createSession(input: CreateSessionInput): Promise<Session> {
  const repo =
    input.repoFullName && input.branch
      ? { fullName: input.repoFullName, branch: input.branch }
      : null;

  const session = await prisma.session.create({
    data: {
      name: input.name,
      repoUrl: repo ? `https://github.com/${repo.fullName}.git` : null,
      branch: repo?.branch ?? null,
      status: 'creating',
      statusMessage: repo ? 'Cloning repository...' : 'Creating workspace...',
      claudeModel: input.claudeModel?.trim() || null,
      createdBySessionId: input.createdBySessionId ?? null,
    },
  });

  // Started now so it overlaps the clone; the first query establishment waits for it.
  resolveAgentName(session.id, input.initialPrompt).catch((error) => {
    log.error('Agent name resolution failed', toError(error), { sessionId: session.id });
  });

  setupSession(session.id, repo, input.initialPrompt).catch((error) => {
    log.error('Unhandled error in session setup', toError(error), { sessionId: session.id });
  });

  return session;
}

async function setupSession(
  sessionId: string,
  repo: { fullName: string; branch: string } | null,
  initialPrompt: string | undefined
): Promise<void> {
  log.info('Starting session setup', { sessionId, repo });

  const setStatusMessage = (statusMessage: string) =>
    transitionSession(sessionId, 'setupProgress', { statusMessage });

  let result: TransitionResult;
  try {
    let repoPath = '';
    if (repo) {
      result = await setStatusMessage('Cloning repository...');
      if (!result.applied) return logSetupAbandoned(sessionId, result.session);
      ({ repoPath } = await cloneRepo({
        sessionId,
        repoFullName: repo.fullName,
        branch: repo.branch,
      }));
      log.info('Worktree created', { sessionId, repoPath });
    } else {
      result = await setStatusMessage('Creating workspace...');
      if (!result.applied) return logSetupAbandoned(sessionId, result.session);
      await createEmptyWorkspace(sessionId);
    }

    result = await transitionSession(sessionId, 'setupComplete', {
      repoPath,
      status: 'running',
      statusMessage: null,
    });
  } catch (error) {
    log.error('Session setup failed', toError(error), { sessionId, repo });
    result = await transitionSession(sessionId, 'setupFailed', {
      status: 'error',
      statusMessage: error instanceof Error ? error.message : 'Failed to create session',
    });
  }

  if (!result.applied) {
    logSetupAbandoned(sessionId, result.session);
    // Deleted mid-setup: delete removed the workspace while the clone was still
    // writing into it, so clear whatever the clone left behind.
    if (result.session.status === 'archived') await removeWorkspace(sessionId);
    return;
  }
  if (result.session.status !== 'running') return;

  log.info('Session setup complete', { sessionId });

  // sendUserMessage establishes the streaming query (loading settings
  // internally) and pushes the prompt.
  if (initialPrompt?.trim()) {
    log.info('Sending initial prompt', { sessionId });
    sendUserMessage(sessionId, initialPrompt.trim()).catch((err) => {
      log.error('Initial prompt failed', toError(err), { sessionId });
    });
  } else {
    void reviveSession(sessionId);
  }
}

function logSetupAbandoned(sessionId: string, session: Session): void {
  log.info('Session left creating during setup', { sessionId, status: session.status });
}

/**
 * Mark a stopped session running and start its query in the background, so other
 * sessions can reach it before it gets a prompt. Already running is a no-op; any
 * other status can't start (archived has no workspace, creating is still being set up).
 */
export async function startSession(sessionId: string): Promise<Session> {
  const { applied, session } = await transitionSession(sessionId, 'start', { status: 'running' });
  if (applied) {
    void reviveSession(sessionId);
    // Only running sessions drain, so a session stopped while it held queued
    // prompts would otherwise strand them until the next reading change.
    await recomputeRateLimitHolds();
  } else if (session.status !== 'running') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Cannot start session in '${session.status}' state`,
    });
  }
  return session;
}

/**
 * Close the session's query and mark it stopped (the worktree stays, so Start
 * can revive it). Any other session (archived, creating, failed setup) keeps its status.
 */
export async function shutDownSession(sessionId: string): Promise<Session> {
  // Stop any running Claude query (synchronous: closes input + query). This
  // runs even for an archived session: a concurrent send can re-establish a
  // query in the window between delete's cleanupSession and its archive
  // write, and stop has to stay the way out of that. No-op when idle.
  void stopSession(sessionId);

  // Stopping also withdraws a pending rate-limit resume nudge, or Start would
  // have the session pick the cut-short work back up on its own.
  const { session } = await transitionSession(sessionId, 'stop', {
    status: 'stopped',
    resumeAfterRateLimit: false,
  });
  return session;
}

/**
 * Delete: stop the session, archive it (keeping its messages), and remove its
 * workspace. Repeating it on an archived session still tears down, which kills a
 * query a concurrent send re-established (see `shutDownSession`).
 */
export async function archiveSession(sessionId: string): Promise<void> {
  // The in-memory teardown is synchronous; the scope stop is awaited below.
  const stopped = cleanupSession(sessionId);

  // Archive (keeping messages for viewing) and clear the queue before waiting
  // on the stop: while the row still reads `running` with prompts queued, a
  // send or rate-limit drain would revive the session into a fresh scope. The
  // QueuedPrompt cascade never fires for a kept row, so the queue must be
  // cleared here or it waits forever, badged in a read-only transcript.
  const [{ applied }] = await Promise.all([
    transitionSession(sessionId, 'archive', {
      status: 'archived',
      attentionAt: null,
      attentionSummary: null,
    }),
    clearQueuedPrompts(sessionId),
  ]);

  // Remove the workspace only once the session's processes are dead, or a
  // daemon it left running (e.g. `next dev`) recreates files after the rm.
  await stopped;
  // Already archived: whoever archived it owns the workspace removal.
  if (applied) await removeWorkspace(sessionId);
}

/** Set the per-session model override and apply it to the live query. Archived sessions are read-only. */
export async function setSessionModel(
  sessionId: string,
  claudeModel: string | null
): Promise<Session> {
  const { applied, session } = await transitionSession(sessionId, 'configure', { claudeModel });
  if (!applied) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Cannot change the model of an archived session',
    });
  }
  // No-op if the session isn't running.
  await refreshSessionSettings(sessionId);
  return session;
}

/** The lifecycle as the built-in MCP server's session tools see it; handed over at startup. */
export const sessionToolsPort: SessionToolsPort = {
  async renameSession(sessionId, name) {
    await updateSession(sessionId, { name });
  },
  createSession,
  stopSession: shutDownSession,
  isTurnActive: isClaudeRunning,
  deliverMessage: (sessionId, text) =>
    sendUserMessage(sessionId, text, [], { userInitiated: false }),
};
