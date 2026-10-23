import { z } from 'zod';
import { router, protectedProcedure, sessionProcedure, runningSessionProcedure } from '../trpc';
import { TRPCError } from '@trpc/server';
import {
  sendUserMessage,
  interruptClaude,
  isClaudeRunning,
  submitLiveToolResponse,
  stopBackgroundTask,
} from '../services/claude-runner';
import {
  loadHistoryPage,
  loadToolResultText,
  markLastMessageAsInterrupted,
  persistSyntheticToolResult,
} from '../services/message-store';
import { PROMPT_MAX_LENGTH } from '@/lib/types';
import { storedNamesSchema } from '@/lib/attachments';
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
 * The caller (UI) never needs to know which path is taken. The session must
 * already be known to be running (see `runningSessionProcedure`).
 */
async function submitToolResponse(
  sessionId: string,
  toolUseId: string,
  response: ToolResponse
): Promise<{ routed: 'live' | 'fallback' | 'already' }> {
  if (await submitLiveToolResponse(sessionId, toolUseId, response)) {
    return { routed: 'live' };
  }

  // A live promise should have been found above; if a turn is still active it
  // hasn't parked yet (or is busy with something else). Don't start a second
  // turn — let the client retry.
  if (isClaudeRunning(sessionId)) {
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

// One user message: typed text and/or previously-uploaded attachments (stored
// names, see /api/upload). Either typed text or at least one attachment must be
// present.
const messageInputSchema = z
  .object({
    prompt: z.string().max(PROMPT_MAX_LENGTH),
    attachments: storedNamesSchema.optional(),
  })
  .refine((v) => v.prompt.trim().length > 0 || (v.attachments?.length ?? 0) > 0, {
    message: 'A prompt or at least one attachment is required',
  });

export const claudeRouter = router({
  send: runningSessionProcedure.input(messageInputSchema).mutation(async ({ input }) => {
    // A send is always accepted while the session is running and goes straight
    // into the SDK, whatever the agent is doing — the CLI interleaves it into
    // the running turn. Neither a live turn nor background tasks gate input.
    await sendUserMessage(input.sessionId, input.prompt, input.attachments ?? []);

    return { success: true };
  }),

  answerQuestion: runningSessionProcedure
    .input(z.object({ toolUseId: z.string().min(1), answers: z.record(z.string(), z.string()) }))
    .mutation(async ({ input }) => {
      const { routed } = await submitToolResponse(input.sessionId, input.toolUseId, {
        kind: 'questions',
        answers: input.answers,
      });
      return { success: true, routed };
    }),

  respondToPlan: runningSessionProcedure
    .input(
      z.object({
        toolUseId: z.string().min(1),
        approve: z.boolean(),
        feedback: z.string().max(PROMPT_MAX_LENGTH).optional(),
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

  interrupt: sessionProcedure.mutation(async ({ input }) => {
    const { interrupted, cancelled } = await interruptClaude(input.sessionId);

    if (interrupted) {
      await markLastMessageAsInterrupted(input.sessionId);
    }

    // Prompts Stop pulled back before the agent read them. Returned so the
    // composer can restore them rather than silently dropping the user's text.
    return { success: interrupted, cancelled };
  }),

  // Backward pagination; the newest page arrives in the session stream's snapshot.
  getHistory: sessionProcedure
    .input(
      z.object({
        // Pages backward: returns the newest messages older than this sequence.
        cursor: z.number().int().nullish(),
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(({ input }) => loadHistoryPage(input.sessionId, input.cursor, input.limit)),

  // The full text of a tool result whose body history and SSE sent only as a
  // summary. Immutable, so clients cache it for good.
  getToolResult: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        messageId: z.string().min(1),
        toolUseId: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      const text = await loadToolResultText(input.sessionId, input.messageId, input.toolUseId);
      if (text === null) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Tool result not found' });
      }
      return { text };
    }),

  // Stop a single running background task.
  stopBackgroundTask: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid(), taskId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const stopped = await stopBackgroundTask(input.sessionId, input.taskId);
      return { success: stopped };
    }),
});
