import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { sseEvents } from '../services/events';
import type { PrUpdateEvent } from '../services/events';
import { tracked } from '@trpc/server';
import { prisma } from '@/lib/prisma';

export const sseRouter = router({
  // Subscribe to session updates (status changes, etc.)
  onSessionUpdate: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .subscription(async function* ({ input, signal }) {
      // Create an async iterator from event emitter
      const events: Array<{ type: 'session_update'; sessionId: string; session: unknown }> = [];
      let resolveWait: (() => void) | null = null;

      const unsubscribe = sseEvents.onSessionUpdate(input.sessionId, (event) => {
        events.push(event);
        resolveWait?.();
      });

      // Clean up on abort
      signal?.addEventListener('abort', () => {
        unsubscribe();
      });

      try {
        while (!signal?.aborted) {
          if (events.length > 0) {
            const event = events.shift()!;
            yield tracked(event.sessionId, event);
          } else {
            // Wait for next event or abort
            await new Promise<void>((resolve) => {
              resolveWait = resolve;
              const onAbort = () => resolve();
              signal?.addEventListener('abort', onAbort, { once: true });
            });
          }
        }
      } finally {
        unsubscribe();
      }
    }),

  // Subscribe to new messages for a session
  // Optionally accepts afterSequence to catch up on missed messages
  onNewMessage: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        afterSequence: z.number().int().optional(),
      })
    )
    .subscription(async function* ({ input, signal }) {
      const events: Array<{
        type: 'new_message';
        sessionId: string;
        message: {
          id: string;
          sessionId: string;
          sequence: number;
          type: string;
          content: unknown;
          createdAt: Date;
        };
      }> = [];
      let resolveWait: (() => void) | null = null;

      // Start listening to real-time events FIRST (before DB query)
      // to avoid missing messages during the query
      const unsubscribe = sseEvents.onNewMessage(input.sessionId, (event) => {
        // Send full message data so client can update cache directly
        events.push({
          type: 'new_message',
          sessionId: event.sessionId,
          message: {
            id: event.message.id,
            sessionId: event.message.sessionId,
            sequence: event.message.sequence,
            type: event.message.type,
            content: event.message.content,
            createdAt: event.message.createdAt,
          },
        });
        resolveWait?.();
      });

      signal?.addEventListener('abort', () => {
        unsubscribe();
      });

      try {
        // Query for missed messages if cursor provided
        if (input.afterSequence !== undefined) {
          const missedMessages = await prisma.message.findMany({
            where: {
              sessionId: input.sessionId,
              sequence: { gt: input.afterSequence },
            },
            orderBy: { sequence: 'asc' },
          });

          // Yield missed messages first
          for (const msg of missedMessages) {
            yield tracked(msg.id, {
              type: 'new_message' as const,
              sessionId: msg.sessionId,
              message: {
                id: msg.id,
                sessionId: msg.sessionId,
                sequence: msg.sequence,
                type: msg.type,
                content: JSON.parse(msg.content),
                createdAt: msg.createdAt,
              },
            });
          }
        }

        // Then stream real-time events (client deduplicates any overlap)
        // Partial messages (id starting with "partial-") need unique tracking IDs
        // so tRPC doesn't deduplicate subsequent updates to the same partial
        let partialCounter = 0;
        while (!signal?.aborted) {
          if (events.length > 0) {
            const event = events.shift()!;
            const isPartial = event.message.id.startsWith('partial-');
            const trackingId = isPartial
              ? `${event.message.id}-${partialCounter++}`
              : event.message.id;
            yield tracked(trackingId, event);
          } else {
            await new Promise<void>((resolve) => {
              resolveWait = resolve;
              const onAbort = () => resolve();
              signal?.addEventListener('abort', onAbort, { once: true });
            });
          }
        }
      } finally {
        unsubscribe();
      }
    }),

  // Subscribe to Claude running state changes
  onClaudeRunning: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .subscription(async function* ({ input, signal }) {
      const events: Array<{ type: 'claude_running'; sessionId: string; running: boolean }> = [];
      let resolveWait: (() => void) | null = null;

      const unsubscribe = sseEvents.onClaudeRunning(input.sessionId, (event) => {
        events.push(event);
        resolveWait?.();
      });

      signal?.addEventListener('abort', () => {
        unsubscribe();
      });

      try {
        while (!signal?.aborted) {
          if (events.length > 0) {
            const event = events.shift()!;
            yield tracked(`${event.sessionId}-${event.running}`, event);
          } else {
            await new Promise<void>((resolve) => {
              resolveWait = resolve;
              const onAbort = () => resolve();
              signal?.addEventListener('abort', onAbort, { once: true });
            });
          }
        }
      } finally {
        unsubscribe();
      }
    }),

  // Subscribe to supported slash commands updates
  onCommands: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .subscription(async function* ({ input, signal }) {
      const events: Array<{
        type: 'commands';
        sessionId: string;
        commands: Array<{ name: string; description: string; argumentHint: string }>;
      }> = [];
      let resolveWait: (() => void) | null = null;
      let counter = 0;

      const unsubscribe = sseEvents.onCommands(input.sessionId, (event) => {
        events.push(event);
        resolveWait?.();
      });

      signal?.addEventListener('abort', () => {
        unsubscribe();
      });

      try {
        while (!signal?.aborted) {
          if (events.length > 0) {
            const event = events.shift()!;
            yield tracked(`${event.sessionId}-commands-${counter++}`, event);
          } else {
            await new Promise<void>((resolve) => {
              resolveWait = resolve;
              const onAbort = () => resolve();
              signal?.addEventListener('abort', onAbort, { once: true });
            });
          }
        }
      } finally {
        unsubscribe();
      }
    }),

  // Subscribe to PR status updates for a session
  onPrUpdate: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .subscription(async function* ({ input, signal }) {
      const events: PrUpdateEvent[] = [];
      let resolveWait: (() => void) | null = null;
      let counter = 0;

      const unsubscribe = sseEvents.onPrUpdate(input.sessionId, (event) => {
        events.push(event);
        resolveWait?.();
      });

      signal?.addEventListener('abort', () => {
        unsubscribe();
      });

      try {
        while (!signal?.aborted) {
          if (events.length > 0) {
            const event = events.shift()!;
            yield tracked(`${event.sessionId}-pr-${counter++}`, event);
          } else {
            await new Promise<void>((resolve) => {
              resolveWait = resolve;
              const onAbort = () => resolve();
              signal?.addEventListener('abort', onAbort, { once: true });
            });
          }
        }
      } finally {
        unsubscribe();
      }
    }),
});
