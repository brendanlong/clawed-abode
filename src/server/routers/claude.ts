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
        afterSequence: z.number().int().optional(),
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

      let cursor = input.afterSequence ?? -1;

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
          yield {
            id: msg.id,
            type: msg.type,
            content: JSON.parse(msg.content),
            sequence: msg.sequence,
            createdAt: msg.createdAt,
          };
          cursor = msg.sequence;
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
        // For infinite query, cursor comes from React Query's pageParam
        cursor: z.number().int().optional(),
        // tRPC adds direction for infinite queries, we ignore it (always paginate backwards)
        direction: z.enum(['forward', 'backward']).optional(),
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

      // Paginate backwards (load older messages)
      const whereClause: {
        sessionId: string;
        sequence?: { lt: number };
      } = {
        sessionId: input.sessionId,
      };

      if (input.cursor !== undefined) {
        whereClause.sequence = { lt: input.cursor };
      }

      const messages = await prisma.message.findMany({
        where: whereClause,
        orderBy: { sequence: 'desc' },
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

      // Reverse so client gets chronological order (oldest first)
      parsedMessages.reverse();

      // Next cursor is the oldest message's sequence (for loading even older)
      const nextCursor = parsedMessages.length > 0 ? parsedMessages[0].sequence : undefined;

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
