import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { TRPCError } from '@trpc/server';
import {
  runClaudeCommand,
  interruptClaude,
  isClaudeRunningAsync,
  markLastMessageAsInterrupted,
  submitLiveToolResponse,
  persistSyntheticToolResult,
  getSessionCommands,
} from '../services/claude-runner';
import { loadMergedSessionSettings } from '../services/settings-merger';
import { getSessionWorkingDir } from '../services/worktree-manager';
import { estimateTokenUsage } from '@/lib/token-estimation';
import { createLogger, toError } from '@/lib/logger';
import { extractRepoFullName } from '@/lib/utils';
import {
  type ToolResponse,
  summarizeToolResponse,
  formatToolResponsePrompt,
} from '@/lib/tool-response';

const log = createLogger('claude');

/** Minimal session fields needed to launch a Claude query. */
type LaunchableSession = { repoUrl: string | null; repoPath: string };

/**
 * Load merged settings and start a Claude query in the background.
 * Shared by `send` and the tool-response fallback path.
 */
async function launchClaude(
  session: LaunchableSession,
  sessionId: string,
  prompt: string
): Promise<void> {
  const repoFullName = session.repoUrl ? extractRepoFullName(session.repoUrl) : null;
  const settingsKey = repoFullName ?? '__no_repo__';
  const settings = await loadMergedSessionSettings(settingsKey);
  const workingDir = getSessionWorkingDir(sessionId, session.repoPath);

  log.info('Launching Claude command', { sessionId, workingDir });

  // Start Claude in the background - don't await
  runClaudeCommand({
    sessionId,
    prompt,
    workingDir,
    customSystemPrompt: settings.customSystemPrompt,
    globalSettings: settings.globalSettings,
    claudeModel: settings.claudeModel,
    envVars: settings.envVars,
    claudeApiKey: settings.claudeApiKey,
    mcpServers: settings.mcpServers,
  }).catch((err) => {
    log.error('Claude command failed', toError(err), { sessionId });
  });
}

/**
 * Deliver a response to an interactive tool call (AskUserQuestion / ExitPlanMode),
 * choosing how to route it based on authoritative server state:
 *
 * 1. If the query is still parked in `canUseTool`, resolve the live promise and
 *    continue the same turn.
 * 2. Otherwise the query has ended (completed, stopped, or the server
 *    restarted) — the original tool call can't be resolved. Mark it answered
 *    with a synthetic tool_result (idempotent) and resume with a new turn.
 *
 * The caller (UI) never needs to know which path is taken.
 */
async function submitToolResponse(
  sessionId: string,
  toolUseId: string,
  response: ToolResponse
): Promise<{ routed: 'live' | 'fallback' | 'already' }> {
  if (await submitLiveToolResponse(sessionId, toolUseId, response)) {
    return { routed: 'live' };
  }

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { status: true, repoUrl: true, repoPath: true },
  });
  if (!session) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }
  if (session.status !== 'running') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Session is not running. Start it to respond.',
    });
  }
  // A live promise should have been found above; if a query is still running it
  // hasn't parked yet (or is busy with something else). Don't start a second
  // turn — let the client retry.
  if (await isClaudeRunningAsync(sessionId)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Claude is still processing. Try again in a moment.',
    });
  }

  const wrote = await persistSyntheticToolResult(
    sessionId,
    toolUseId,
    summarizeToolResponse(response)
  );
  if (!wrote) {
    return { routed: 'already' };
  }

  await launchClaude(session, sessionId, formatToolResponsePrompt(response));
  return { routed: 'fallback' };
}

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
        select: { status: true, repoUrl: true, repoPath: true },
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

      await launchClaude(session, input.sessionId, input.prompt);

      return { success: true };
    }),

  answerQuestion: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        toolUseId: z.string().min(1),
        answers: z.record(z.string(), z.string()),
      })
    )
    .mutation(async ({ input }) => {
      const { routed } = await submitToolResponse(input.sessionId, input.toolUseId, {
        kind: 'questions',
        answers: input.answers,
      });
      return { success: true, routed };
    }),

  respondToPlan: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        toolUseId: z.string().min(1),
        approve: z.boolean(),
        feedback: z.string().max(100000).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { routed } = await submitToolResponse(input.sessionId, input.toolUseId, {
        kind: 'plan',
        approve: input.approve,
        feedback: input.feedback,
      });
      return { success: true, routed };
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
