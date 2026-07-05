import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { TRPCError } from '@trpc/server';
import {
  cloneRepo,
  createEmptyWorkspace,
  removeWorkspace,
  getSessionWorkingDir,
} from '../services/worktree-manager';
import { buildEditorUrl } from '@/lib/editor-url';
import {
  sendUserMessage,
  stopSession,
  cleanupSession,
  isClaudeRunning,
} from '../services/claude-runner';
import { resolveUploadPaths } from '../services/uploads';
import {
  reserveInitialAttachments,
  resolveInitialAttachments,
  awaitInitialAttachments,
  clearInitialAttachments,
} from '../services/initial-attachments';
import { sseEvents } from '../services/events';
import { createLogger, toError } from '@/lib/logger';
import { env } from '@/lib/env';
import { SESSION_NAME_MAX_LENGTH } from '@/lib/types';
import { MAX_ATTACHMENTS } from '@/lib/attachments';

const log = createLogger('sessions');

/**
 * How long the background setup waits for the client to register the initial
 * prompt's uploaded attachments before sending the prompt without them. The
 * client registers right after uploading (typically while the clone is still
 * running), so this only bites when the client abandons the flow after create.
 */
const INITIAL_ATTACHMENTS_TIMEOUT_MS = 60_000;

const sessionStatusSchema = z.enum(['creating', 'running', 'stopped', 'error', 'archived']);

// Background session setup - runs after create mutation returns
async function setupSessionBackground(
  sessionId: string,
  repoFullName: string | null,
  branch: string | null,
  initialPrompt: string | undefined,
  waitForAttachments: boolean,
  githubToken?: string
): Promise<void> {
  log.info('Starting session setup', { sessionId, repoFullName, branch, waitForAttachments });

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

    // If the initial prompt carries attachments, wait for the client to register
    // the uploaded files (it does so right after create, usually while cloning
    // was still running) before building the prompt. The workspace now exists, so
    // resolve the stored names to absolute paths for the attachment prefix.
    let attachmentPaths: string[] = [];
    if (waitForAttachments) {
      const storedNames = await awaitInitialAttachments(sessionId, INITIAL_ATTACHMENTS_TIMEOUT_MS);
      attachmentPaths = await resolveUploadPaths(sessionId, storedNames);
      log.info('Resolved initial attachments', { sessionId, count: attachmentPaths.length });
    }

    // Send the initial prompt if there is text or at least one attachment.
    // sendUserMessage establishes the streaming query (loading settings
    // internally), prefixes the attachment paths, and pushes the prompt.
    const trimmedPrompt = initialPrompt?.trim() ?? '';
    if (trimmedPrompt || attachmentPaths.length > 0) {
      log.info('Sending initial prompt', { sessionId, attachments: attachmentPaths.length });
      sendUserMessage(sessionId, trimmedPrompt, attachmentPaths).catch((err) => {
        log.error('Initial prompt failed', toError(err), { sessionId });
      });
    }
  } catch (error) {
    // Drop any reserved rendezvous slot so a late register call doesn't leak.
    clearInitialAttachments(sessionId);
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
        // Set when the client will upload attachments for the initial prompt
        // after this call (see `setInitialAttachments`). The background setup
        // then waits for those files before sending the initial prompt.
        hasInitialAttachments: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const githubToken = env.GITHUB_TOKEN;
      const hasRepo = !!input.repoFullName && !!input.branch;
      const waitForAttachments = input.hasInitialAttachments ?? false;

      const session = await prisma.session.create({
        data: {
          name: input.name,
          repoUrl: hasRepo ? `https://github.com/${input.repoFullName}.git` : null,
          branch: hasRepo ? input.branch! : null,
          workspacePath: '',
          status: 'creating',
          statusMessage: hasRepo ? 'Cloning repository...' : 'Creating workspace...',
          initialPrompt: input.initialPrompt,
        },
      });

      // Reserve the rendezvous slot before starting setup so the background
      // await and the client's register call meet on the same reservation
      // regardless of which lands first.
      if (waitForAttachments) {
        reserveInitialAttachments(session.id);
      }

      // Start setup in background
      setupSessionBackground(
        session.id,
        input.repoFullName ?? null,
        input.branch ?? null,
        input.initialPrompt,
        waitForAttachments,
        githubToken
      ).catch((error) => {
        log.error('Unhandled error in session setup', toError(error), { sessionId: session.id });
      });

      return { session };
    }),

  // Register the uploaded attachments for a session's initial prompt. Called by
  // the new-session flow right after uploading files (via /api/upload) to the
  // freshly created session, so the background setup can prefix them onto the
  // initial prompt once the workspace is ready.
  setInitialAttachments: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        attachments: z.array(z.string().min(1).max(255)).min(1).max(MAX_ATTACHMENTS),
      })
    )
    .mutation(async ({ input }) => {
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
        select: { id: true },
      });
      if (!session) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
      }

      resolveInitialAttachments(input.sessionId, input.attachments);
      return { success: true };
    }),

  list: protectedProcedure
    .input(
      z
        .object({
          status: sessionStatusSchema.optional(),
          includeArchived: z.boolean().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const includeArchived = input?.includeArchived ?? false;

      const sessions = await prisma.session.findMany({
        where: {
          ...(input?.status ? { status: input.status } : {}),
          ...(!includeArchived && !input?.status ? { status: { not: 'archived' } } : {}),
        },
        orderBy: { lastActivityAt: 'desc' },
      });

      // Attach the live main-agent turn state (in-memory lookup, no extra query)
      // so the list can distinguish "running" (generating) from "waiting" (idle).
      return {
        sessions: sessions.map((session) => ({
          ...session,
          turnActive: isClaudeRunning(session.id),
        })),
      };
    }),

  get: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ input }) => {
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
      });

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      return { session };
    }),

  // Deep link into a self-hosted code-server (browser VS Code) instance opened
  // on this session's worktree folder. Returns { url: null } when the editor is
  // not configured (CODE_SERVER_URL unset) or the session has no workspace on
  // disk (archived), so the UI can hide the button.
  getEditorUrl: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ input }) => {
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
      });

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      // Archived sessions have their workspace removed from disk.
      if (session.status === 'archived') {
        return { url: null };
      }

      const workingDir = getSessionWorkingDir(session.id, session.repoPath);
      return { url: buildEditorUrl(env.CODE_SERVER_URL, workingDir) };
    }),

  start: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
      });

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      if (session.status === 'running') {
        return { session };
      }

      // Only stopped or error sessions can be started.
      // Archived sessions have their workspace removed, creating sessions are in progress.
      if (session.status !== 'stopped' && session.status !== 'error') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Cannot start session in '${session.status}' state`,
        });
      }

      // For the new architecture, "starting" just means marking as running.
      // The workspace (worktree) already exists on disk.
      // Claude queries run in-process when the user sends a prompt.
      const updatedSession = await prisma.session.update({
        where: { id: session.id },
        data: { status: 'running' },
      });

      sseEvents.emitSessionUpdate(input.sessionId, updatedSession);
      return { session: updatedSession };
    }),

  rename: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        name: z.string().trim().min(1).max(SESSION_NAME_MAX_LENGTH),
      })
    )
    .mutation(async ({ input }) => {
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
      });

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      // Renaming only changes the display name; the session id and workspace
      // are untouched. lastActivityAt is deliberately not bumped so renaming
      // doesn't reorder the session list.
      const updatedSession = await prisma.session.update({
        where: { id: session.id },
        data: { name: input.name },
      });

      sseEvents.emitSessionUpdate(input.sessionId, updatedSession);
      return { session: updatedSession };
    }),

  stop: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
      });

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      // Stop any running Claude query (synchronous: closes input + query).
      stopSession(input.sessionId);

      const updatedSession = await prisma.session.update({
        where: { id: session.id },
        data: { status: 'stopped' },
      });

      sseEvents.emitSessionUpdate(input.sessionId, updatedSession);
      return { session: updatedSession };
    }),

  delete: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
      });

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      if (session.status === 'archived') {
        return { success: true };
      }

      // Stop any running query and clean up all in-memory state
      cleanupSession(input.sessionId);

      // Remove workspace directory
      await removeWorkspace(session.id);

      // Archive session (keep messages for viewing)
      const updatedSession = await prisma.session.update({
        where: { id: session.id },
        data: {
          status: 'archived',
          archivedAt: new Date(),
        },
      });

      sseEvents.emitSessionUpdate(input.sessionId, updatedSession);
      return { success: true };
    }),

  syncStatus: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      // In the new architecture, session status is authoritative in the DB.
      // No external process/container to sync with.
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
      });

      return { session };
    }),
});
