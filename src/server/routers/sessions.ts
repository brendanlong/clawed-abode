import { z } from 'zod';
import { router, protectedProcedure, sessionProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { TRPCError } from '@trpc/server';
import {
  cloneRepo,
  createEmptyWorkspace,
  removeWorkspace,
  getSessionWorkspacePath,
} from '../services/worktree-manager';
import { buildEditorUrl } from '@/lib/editor-url';
import {
  sendUserMessage,
  stopSession,
  cleanupSession,
  isClaudeRunning,
  isSessionBackgroundActive,
  isSessionRateLimitPaused,
  recomputeRateLimitHolds,
  refreshSessionSettings,
} from '../services/claude-runner';
import { sseEvents } from '../services/events';
import { createLogger, toError } from '@/lib/logger';
import { env } from '@/lib/env';
import { SESSION_NAME_MAX_LENGTH } from '@/lib/types';
import { toSessionView } from '@/lib/session-view';
import type { Prisma } from '@/generated/prisma/client';
import { keysetPage, keysetPageInputSchema } from '@/lib/keyset-page';
import { sessionStatusSchema } from '@/lib/session-display-status';
import { thresholdSchema } from './rateLimit';
import { clearQueuedPrompts } from '../services/prompt-queue';

const log = createLogger('sessions');

const sessionListSelect = {
  id: true,
  name: true,
  repoUrl: true,
  branch: true,
  status: true,
  statusMessage: true,
  currentBranch: true,
  pullRequest: true,
  lastActivityAt: true,
  createdAt: true,
} satisfies Prisma.SessionSelect;

// Background session setup - runs after create mutation returns
async function setupSessionBackground(
  sessionId: string,
  repoFullName: string | null,
  branch: string | null,
  initialPrompt: string | undefined,
  githubToken?: string
): Promise<void> {
  log.info('Starting session setup', { sessionId, repoFullName, branch });

  const updateStatus = async (message: string) => {
    const session = await prisma.session.update({
      where: { id: sessionId },
      data: { statusMessage: message },
    });
    sseEvents.emitSessionUpdate(sessionId, session);
  };

  try {
    let repoPath = '';

    if (repoFullName && branch) {
      // Set up a git worktree for this session
      await updateStatus('Cloning repository...');
      const result = await cloneRepo({
        sessionId,
        repoFullName,
        branch,
        githubToken,
      });
      repoPath = result.repoPath;
      log.info('Worktree created', { sessionId, repoPath });
    } else {
      // No-repo session: create an empty workspace directory
      await updateStatus('Creating workspace...');
      await createEmptyWorkspace(sessionId);
    }

    // Session is ready - mark as running
    const session = await prisma.session.update({
      where: { id: sessionId },
      data: {
        repoPath,
        status: 'running',
        statusMessage: null,
      },
    });
    sseEvents.emitSessionUpdate(sessionId, session);

    log.info('Session setup complete', { sessionId });

    // Send the initial prompt if provided. sendUserMessage establishes the
    // streaming query (loading settings internally) and pushes the prompt.
    if (initialPrompt?.trim()) {
      log.info('Sending initial prompt', { sessionId });
      sendUserMessage(sessionId, initialPrompt.trim()).catch((err) => {
        log.error('Initial prompt failed', toError(err), { sessionId });
      });
    }
  } catch (error) {
    log.error('Session setup failed', toError(error), { sessionId, repoFullName, branch });

    const errorMessage = error instanceof Error ? error.message : 'Failed to create session';
    const session = await prisma.session.update({
      where: { id: sessionId },
      data: {
        status: 'error',
        statusMessage: errorMessage,
      },
    });
    sseEvents.emitSessionUpdate(sessionId, session);
  }
}

export const sessionsRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(SESSION_NAME_MAX_LENGTH),
        repoFullName: z
          .string()
          .regex(/^[\w-]+\/[\w.-]+$/)
          .optional(),
        branch: z.string().min(1).optional(),
        initialPrompt: z.string().max(100000).optional(),
        claudeModel: z.string().max(200).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const githubToken = env.GITHUB_TOKEN;
      const hasRepo = !!input.repoFullName && !!input.branch;

      const session = await prisma.session.create({
        data: {
          name: input.name,
          repoUrl: hasRepo ? `https://github.com/${input.repoFullName}.git` : null,
          branch: hasRepo ? input.branch! : null,
          status: 'creating',
          statusMessage: hasRepo ? 'Cloning repository...' : 'Creating workspace...',
          claudeModel: input.claudeModel?.trim() || null,
        },
      });

      // Start setup in background
      setupSessionBackground(
        session.id,
        input.repoFullName ?? null,
        input.branch ?? null,
        input.initialPrompt,
        githubToken
      ).catch((error) => {
        log.error('Unhandled error in session setup', toError(error), { sessionId: session.id });
      });

      return { session: toSessionView(session) };
    }),

  // Keyset-paginated by (lastActivityAt desc, id desc). Archived sessions are
  // excluded unless `status: 'archived'` is requested explicitly, so the home page
  // fetches the active and archived lists as two independent paginated queries.
  list: protectedProcedure
    .input(keysetPageInputSchema.extend({ status: sessionStatusSchema.optional() }))
    .query(async ({ input }) => {
      const page = keysetPage('lastActivityAt', input);
      const rows = await prisma.session.findMany({
        where: {
          ...(input.status ? { status: input.status } : { status: { not: 'archived' } }),
          ...page.where,
        },
        orderBy: page.orderBy,
        take: page.take,
        select: sessionListSelect,
      });
      const { items, nextCursor } = page.slice(rows);

      // Attach the live status axes (in-memory lookups, no extra query) so the
      // list can distinguish "running" (main agent generating) from "background"
      // (only a subagent/background task running) from "waiting" (fully idle).
      return {
        sessions: items.map((session) => ({
          ...toSessionView(session),
          turnActive: isClaudeRunning(session.id),
          backgroundActive: isSessionBackgroundActive(session.id),
          rateLimitPaused: isSessionRateLimitPaused(session.id),
        })),
        nextCursor,
      };
    }),

  get: sessionProcedure.query(({ ctx }) => ({ session: toSessionView(ctx.session) })),

  // Deep link into a self-hosted code-server (browser VS Code) instance opened
  // on this session's worktree folder. Returns { url: null } when the editor is
  // not configured (CODE_SERVER_URL unset) or the session has no workspace on
  // disk (archived), so the UI can hide the button.
  getEditorUrl: sessionProcedure.query(({ ctx }) => {
    const { session } = ctx;

    // Archived sessions have their workspace removed from disk.
    if (session.status === 'archived') {
      return { url: null };
    }

    // Open the session's workspace root (not just the repo checkout) so the
    // operator sees all of the session's files — the repo clone alongside the
    // uploads/ sibling folder.
    const workspaceDir = getSessionWorkspacePath(session.id);
    return { url: buildEditorUrl(env.CODE_SERVER_URL, workspaceDir) };
  }),

  start: sessionProcedure.mutation(async ({ ctx, input }) => {
    const { session } = ctx;

    if (session.status === 'running') {
      return { session: toSessionView(session) };
    }

    // Only stopped or error sessions can be started.
    // Archived sessions have their workspace removed, creating sessions are in progress.
    if (session.status !== 'stopped' && session.status !== 'error') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Cannot start session in '${session.status}' state`,
      });
    }

    // Queries run in-process and are established lazily on the next prompt.
    const updatedSession = await prisma.session.update({
      where: { id: session.id },
      data: { status: 'running' },
    });

    sseEvents.emitSessionUpdate(input.sessionId, updatedSession);
    // Only running sessions drain, so a session stopped while it held queued
    // prompts would otherwise strand them until the next reading change.
    await recomputeRateLimitHolds();
    return { session: toSessionView(updatedSession) };
  }),

  rename: sessionProcedure
    .input(z.object({ name: z.string().trim().min(1).max(SESSION_NAME_MAX_LENGTH) }))
    .mutation(async ({ ctx, input }) => {
      const { session } = ctx;

      // Renaming only changes the display name; the session id and workspace
      // are untouched. lastActivityAt is deliberately not bumped so renaming
      // doesn't reorder the session list.
      const updatedSession = await prisma.session.update({
        where: { id: session.id },
        data: { name: input.name },
      });

      sseEvents.emitSessionUpdate(input.sessionId, updatedSession);
      return { session: toSessionView(updatedSession) };
    }),

  // Set the per-session Claude model override (highest precedence — see
  // resolveClaudeModel). Pass null/empty to clear (reverts to repo/global/env
  // model). Persisted, so it survives restarts; applied live to a running query
  // on the next turn (refreshSessionSettings applies it now if idle).
  /**
   * Per-session rate-limit pause overrides; null on either field inherits the
   * global default (see resolvePausePolicy). Recomputes holds immediately so a
   * lowered threshold parks work now rather than at the next reading.
   */
  setRateLimitPause: sessionProcedure
    .input(
      z.object({
        enabled: z.boolean().nullable(),
        threshold: thresholdSchema.nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const updatedSession = await prisma.session.update({
        where: { id: ctx.session.id },
        data: {
          rateLimitPauseEnabled: input.enabled,
          rateLimitPauseThreshold: input.threshold,
        },
      });
      await recomputeRateLimitHolds();
      sseEvents.emitSessionUpdate(input.sessionId, updatedSession);
      return { session: toSessionView(updatedSession) };
    }),

  setModel: sessionProcedure
    .input(z.object({ claudeModel: z.string().max(200).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const { session } = ctx;

      // Archived sessions are read-only (workspace removed, no live query).
      if (session.status === 'archived') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Cannot change the model of an archived session',
        });
      }

      const model = input.claudeModel?.trim() || null;

      const updatedSession = await prisma.session.update({
        where: { id: session.id },
        data: { claudeModel: model },
      });

      // Apply to the live query now (no-op if the session isn't running).
      await refreshSessionSettings(input.sessionId);

      sseEvents.emitSessionUpdate(input.sessionId, updatedSession);
      return { session: toSessionView(updatedSession) };
    }),

  stop: sessionProcedure.mutation(async ({ ctx, input }) => {
    const { session } = ctx;

    // Stop any running Claude query (synchronous: closes input + query). This
    // runs even for an archived session: a concurrent send can re-establish a
    // query in the window between delete's cleanupSession and its archive
    // write, and stop has to stay the way out of that. No-op when idle.
    stopSession(input.sessionId);

    // Archived sessions keep their status — the workspace is already gone, and
    // 'stopped' would let start() revive the session with nothing on disk.
    if (session.status === 'archived') {
      return { session: toSessionView(session) };
    }

    const updatedSession = await prisma.session.update({
      where: { id: session.id },
      data: { status: 'stopped' },
    });

    sseEvents.emitSessionUpdate(input.sessionId, updatedSession);
    return { session: toSessionView(updatedSession) };
  }),

  delete: sessionProcedure.mutation(async ({ ctx, input }) => {
    const { session } = ctx;

    if (session.status === 'archived') {
      return { success: true };
    }

    // Stop any running query and clean up all in-memory state
    cleanupSession(input.sessionId);

    // Archiving keeps the session row, so the QueuedPrompt cascade never fires
    // and nothing drains an archived session — clear the queue here or it waits
    // forever, counted in the paused banner and badged in a read-only transcript.
    await clearQueuedPrompts(session.id);

    // Remove workspace directory
    await removeWorkspace(session.id);

    // Archive session (keep messages for viewing)
    const updatedSession = await prisma.session.update({
      where: { id: session.id },
      data: { status: 'archived' },
    });

    sseEvents.emitSessionUpdate(input.sessionId, updatedSession);
    return { success: true };
  }),
});
