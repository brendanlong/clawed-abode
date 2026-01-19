import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { TRPCError } from '@trpc/server';
import { runClaudeCommand, interruptClaude, isClaudeRunning } from '../services/claude-runner';

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

      if (isClaudeRunning(input.sessionId)) {
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

  subscribe: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        afterCursor: z.number().int().optional(),
      })
    )
    .subscription(async function* ({ input }) {
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
      });

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      let cursor = input.afterCursor ?? -1;

      while (true) {
        const messages = await prisma.message.findMany({
          where: {
            sessionId: input.sessionId,
            sequence: { gt: cursor },
          },
          orderBy: { sequence: 'asc' },
          take: 100,
        });

        for (const msg of messages) {
          cursor = msg.sequence;
          yield {
            id: msg.id,
            type: msg.type,
            content: JSON.parse(msg.content),
            sequence: msg.sequence,
            cursor, // Include cursor for client to track
            createdAt: msg.createdAt,
          };
        }

        // Poll interval
        await new Promise((r) => setTimeout(r, 100));
      }
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
        cursor: z.number().int().optional(),
        direction: z.enum(['forward', 'backward']).default('backward'),
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

      const isBackward = input.direction === 'backward';

      // Build where clause based on direction
      const whereClause: {
        sessionId: string;
        sequence?: { lt: number } | { gt: number };
      } = {
        sessionId: input.sessionId,
      };

      if (input.cursor !== undefined) {
        // backward: load older (sequence < cursor)
        // forward: load newer (sequence > cursor)
        whereClause.sequence = isBackward ? { lt: input.cursor } : { gt: input.cursor };
      }

      const messages = await prisma.message.findMany({
        where: whereClause,
        // backward: newest first (so we get the N most recent before cursor)
        // forward: oldest first (so we get the N oldest after cursor)
        orderBy: { sequence: isBackward ? 'desc' : 'asc' },
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

      // For backward pagination, reverse so client gets chronological order
      if (isBackward) {
        parsedMessages.reverse();
      }

      // Cursor for next page depends on direction:
      // backward: oldest message's sequence (to load even older)
      // forward: newest message's sequence (to load even newer)
      const nextCursor =
        parsedMessages.length > 0
          ? isBackward
            ? parsedMessages[0].sequence
            : parsedMessages[parsedMessages.length - 1].sequence
          : undefined;

      return {
        messages: parsedMessages,
        nextCursor,
        hasMore,
      };
    }),

  isRunning: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(({ input }) => {
      return { running: isClaudeRunning(input.sessionId) };
    }),
});
