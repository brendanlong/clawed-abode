import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { TRPCError } from '@trpc/server';
import { runClaudeCommand, interruptClaude, isClaudeRunningAsync } from '../services/claude-runner';

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

      if (session.status !== 'running' || !session.containerId) {
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

      // Start Claude in the background - don't await
      runClaudeCommand(input.sessionId, session.containerId, input.prompt).catch((err) => {
        console.error('Claude command failed:', err);
      });

      return { success: true };
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

      return { success: interrupted };
    }),

  getHistory: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        // Cursor encodes both position and direction for bidirectional pagination
        // sequence is optional - when missing, no bound is applied (fetch from start/end)
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
      // Get the newest data in each page for backward cursors
      // Get the oldest data in each page for forward cursors
      // No cursor is a special case since we want the newest data
      // paging backward
      const getNewest = isBackward || input.cursor == null;

      // Build where clause based on direction
      const whereClause: {
        sessionId: string;
        sequence?: { lt: number } | { gt: number };
      } = {
        sessionId: input.sessionId,
      };

      if (input.cursor?.sequence !== undefined) {
        // backward: load older (sequence < cursor)
        // forward: load newer (sequence > cursor)
        whereClause.sequence = isBackward
          ? { lt: input.cursor.sequence }
          : { gt: input.cursor.sequence };
      }

      const messages = await prisma.message.findMany({
        where: whereClause,
        // backward: newest first (so we get the N most recent before cursor)
        // forward: oldest first (so we get the N oldest after cursor)
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

      // For newest first, reverse so client gets chronological order
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
      return { running: await isClaudeRunningAsync(input.sessionId) };
    }),
});
