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
import { loadMergedSessionSettings } from '../services/settings-merger';
import { runClaudeCommand, stopSession } from '../services/claude-runner';
import { sseEvents } from '../services/events';
import { createLogger, toError } from '@/lib/logger';
import { env } from '@/lib/env';

const log = createLogger('sessions');

const sessionStatusSchema = z.enum(['creating', 'running', 'stopped', 'error', 'archived']);

/** Sentinel value for no-repo sessions in RepoSettings */
const NO_REPO_SENTINEL = '__no_repo__';

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

    // Send the initial prompt if provided
    if (initialPrompt?.trim()) {
      log.info('Sending initial prompt', { sessionId });

      const settingsKey = repoFullName ?? NO_REPO_SENTINEL;
      const settings = await loadMergedSessionSettings(settingsKey);
      const workingDir = getSessionWorkingDir(sessionId, repoPath);

      runClaudeCommand({
        sessionId,
        prompt: initialPrompt.trim(),
        workingDir,
        customSystemPrompt: settings.customSystemPrompt,
        globalSettings: settings.globalSettings,
        claudeModel: settings.claudeModel,
        mcpServers: settings.mcpServers,
      }).catch((err) => {
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
        name: z.string().min(1).max(100),
        repoFullName: z
          .string()
          .regex(/^[\w-]+\/[\w.-]+$/)
          .optional(),
        branch: z.string().min(1).optional(),
        initialPrompt: z.string().max(100000).optional(),
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
          workspacePath: '',
          status: 'creating',
          statusMessage: hasRepo ? 'Cloning repository...' : 'Creating workspace...',
          initialPrompt: input.initialPrompt,
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

      return { session };
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
        orderBy: { updatedAt: 'desc' },
      });

      return { sessions };
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

      // Stop any running Claude query
      await stopSession(input.sessionId);

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

      // Stop any running query
      await stopSession(input.sessionId);

      // Remove workspace directory
      await removeWorkspace(session.id);

      // Archive session (keep messages for viewing)
      const updatedSession = await prisma.session.update({
        where: { id: session.id },
        data: {
          status: 'archived',
          archivedAt: new Date(),
          containerId: null,
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
