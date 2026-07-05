import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { TRPCError } from '@trpc/server';
import {
  sendUserMessage,
  interruptClaude,
  isClaudeRunningAsync,
  markLastMessageAsInterrupted,
  submitLiveToolResponse,
  persistSyntheticToolResult,
  getSessionCommands,
  getSessionRetry,
  getSessionBackgroundTasks,
  stopBackgroundTask,
} from '../services/claude-runner';
import { resolveUploadPaths } from '../services/uploads';
import { MAX_ATTACHMENTS } from '@/lib/attachments';
import { estimateTokenUsage } from '@/lib/token-estimation';
import {
  type ToolResponse,
  summarizeToolResponse,
  formatToolResponsePrompt,
} from '@/lib/tool-response';

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
    select: { status: true },
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
  // A live promise should have been found above; if a turn is still active it
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

  await sendUserMessage(sessionId, formatToolResponsePrompt(response));
  return { routed: 'fallback' };
}

export const claudeRouter = router({
  send: protectedProcedure
    .input(
      z
        .object({
          sessionId: z.string().uuid(),
          prompt: z.string().max(100000),
          // Stored names of previously uploaded attachments (see /api/upload).
          attachments: z.array(z.string().min(1).max(255)).max(MAX_ATTACHMENTS).optional(),
        })
        // Either typed text or at least one attachment must be present.
        .refine((v) => v.prompt.trim().length > 0 || (v.attachments?.length ?? 0) > 0, {
          message: 'A prompt or at least one attachment is required',
        })
    )
    .mutation(async ({ input }) => {
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
        select: { status: true },
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

      // Reject only while a main-agent turn is active. A send is allowed while
      // only background tasks are running (they never gate input).
      if (await isClaudeRunningAsync(input.sessionId)) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Claude is already running for this session',
        });
      }

      const attachmentPaths = input.attachments?.length
        ? await resolveUploadPaths(input.sessionId, input.attachments)
        : [];

      await sendUserMessage(input.sessionId, input.prompt, attachmentPaths);

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

      // The context-% calculation needs the latest top-level (main-agent)
      // assistant message; subagent messages (parent_tool_use_id set) run in
      // their own context and would misreport the main conversation's size.
      const [resultAndSystemMessages, lastTopLevelAssistant] = await Promise.all([
        prisma.message.findMany({
          where: {
            sessionId: input.sessionId,
            type: { in: ['result', 'system'] },
          },
          select: { type: true, content: true },
          orderBy: { sequence: 'asc' },
        }),
        prisma.$queryRaw<{ type: string; content: string }[]>`
          SELECT type, content FROM Message
          WHERE sessionId = ${input.sessionId}
            AND type = 'assistant'
            AND json_extract(content, '$.parent_tool_use_id') IS NULL
          ORDER BY sequence DESC
          LIMIT 1
        `,
      ]);

      const allMessages = [...resultAndSystemMessages, ...lastTopLevelAssistant];

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

  // Ephemeral API-retry status (rate limit / overload). Updates stream live over
  // the `retry` SSE channel; this query seeds the initial value and resyncs on
  // reconnect.
  getRetryState: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ input }) => {
      return { retry: getSessionRetry(input.sessionId) };
    }),

  // Running background tasks (run_in_background subagents / Monitor / backgrounded
  // Bash). Updates stream live over the `background` SSE channel; this seeds the
  // initial value and resyncs on reconnect. In-memory only (lost on restart).
  getBackgroundTasks: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ input }) => {
      return { tasks: getSessionBackgroundTasks(input.sessionId) };
    }),

  // Stop a single running background task.
  stopBackgroundTask: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid(), taskId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const stopped = await stopBackgroundTask(input.sessionId, input.taskId);
      return { success: stopped };
    }),
});
