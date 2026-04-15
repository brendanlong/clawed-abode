import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { TRPCError } from '@trpc/server';
import {
  runClaudeCommand,
  interruptClaude,
  isClaudeRunningAsync,
  markLastMessageAsInterrupted,
  answerUserInput,
  hasPendingInput,
  getPendingInput,
  getSessionCommands,
} from '../services/claude-runner';
import { loadMergedSessionSettings } from '../services/settings-merger';
import { getSessionWorkingDir } from '../services/worktree-manager';
import { estimateTokenUsage } from '@/lib/token-estimation';
import { createLogger, toError } from '@/lib/logger';
import { extractRepoFullName } from '@/lib/utils';

const log = createLogger('claude');

export const claudeRouter = router({
  send: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        prompt: z.string().min(1).max(100000),
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

      if (session.status !== 'running') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Session is not running',
        });
      }

      if (await isClaudeRunningAsync(input.sessionId)) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Claude is already running for this session',
        });
      }

      // Load and merge global + per-repo settings
      const repoFullName = session.repoUrl ? extractRepoFullName(session.repoUrl) : null;
      const settingsKey = repoFullName ?? '__no_repo__';
      const settings = await loadMergedSessionSettings(settingsKey);

      // Build working directory
      const workingDir = getSessionWorkingDir(input.sessionId, session.repoPath);

      log.info('Starting Claude command', {
        sessionId: input.sessionId,
        workingDir,
      });

      // Start Claude in the background - don't await
      runClaudeCommand({
        sessionId: input.sessionId,
        prompt: input.prompt,
        workingDir,
        customSystemPrompt: settings.customSystemPrompt,
        globalSettings: settings.globalSettings,
        claudeModel: settings.claudeModel,
        envVars: settings.envVars,
        claudeApiKey: settings.claudeApiKey,
        mcpServers: settings.mcpServers,
      }).catch((err) => {
        log.error('Claude command failed', toError(err), { sessionId: input.sessionId });
      });

      return { success: true };
    }),

  answerQuestion: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        answers: z.record(z.string(), z.string()),
      })
    )
    .mutation(async ({ input }) => {
      const answered = answerUserInput(input.sessionId, input.answers);

      if (!answered) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'No pending question for this session',
        });
      }

      return { success: true };
    }),

  getPendingQuestion: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(({ input }) => {
      const pending = getPendingInput(input.sessionId);
      return { pending };
    }),

  interrupt: protectedProcedure
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

      const interrupted = await interruptClaude(input.sessionId);

      if (interrupted) {
        await markLastMessageAsInterrupted(input.sessionId);
      }

      return { success: interrupted };
    }),

  getHistory: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        cursor: z
          .object({
            sequence: z.number().int().optional(),
            direction: z.enum(['forward', 'backward']),
          })
          .optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
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

      const isBackward = input.cursor?.direction === 'backward';
      const getNewest = isBackward || input.cursor?.sequence == null;

      const whereClause: {
        sessionId: string;
        sequence?: { lt: number } | { gt: number };
      } = {
        sessionId: input.sessionId,
      };

      if (input.cursor?.sequence !== undefined) {
        whereClause.sequence = isBackward
          ? { lt: input.cursor.sequence }
          : { gt: input.cursor.sequence };
      }

      const messages = await prisma.message.findMany({
        where: whereClause,
        orderBy: { sequence: getNewest ? 'desc' : 'asc' },
        take: input.limit + 1,
      });

      const hasMore = messages.length > input.limit;
      if (hasMore) {
        messages.pop();
      }

      const parsedMessages = messages.map((m) => ({
        ...m,
        content: JSON.parse(m.content),
      }));

      if (getNewest) {
        parsedMessages.reverse();
      }

      return {
        messages: parsedMessages,
        hasMore,
      };
    }),

  isRunning: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ input }) => {
      return {
        running: await isClaudeRunningAsync(input.sessionId),
        hasPendingInput: hasPendingInput(input.sessionId),
      };
    }),

  getTokenUsage: protectedProcedure
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

      const [resultAndSystemMessages, lastAssistantMessage] = await Promise.all([
        prisma.message.findMany({
          where: {
            sessionId: input.sessionId,
            type: { in: ['result', 'system'] },
          },
          select: { type: true, content: true, sequence: true },
          orderBy: { sequence: 'asc' },
        }),
        prisma.message.findFirst({
          where: {
            sessionId: input.sessionId,
            type: 'assistant',
          },
          select: { type: true, content: true, sequence: true },
          orderBy: { sequence: 'desc' },
        }),
      ]);

      const allMessages = [...resultAndSystemMessages];
      if (lastAssistantMessage) {
        allMessages.push(lastAssistantMessage);
      }
      allMessages.sort((a, b) => a.sequence - b.sequence);

      const parsedMessages = allMessages.map((m) => ({
        type: m.type,
        content: JSON.parse(m.content),
      }));

      return estimateTokenUsage(parsedMessages);
    }),

  getCommands: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ input }) => {
      return { commands: getSessionCommands(input.sessionId) };
    }),
});
