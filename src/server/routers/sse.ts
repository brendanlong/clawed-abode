import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { sseEvents } from '../services/events';
import type { PrUpdateEvent, SessionStateEvent } from '../services/events';
import { tracked } from '@trpc/server';
import { prisma } from '@/lib/prisma';

/** Wire shape for a message delivered over SSE (content already parsed). */
interface SseMessage {
  id: string;
  sessionId: string;
  sequence: number;
  type: string;
  content: unknown;
  createdAt: Date;
}

interface NewMessageWireEvent {
  type: 'new_message';
  sessionId: string;
  message: SseMessage;
}

/**
 * Shared driver for an SSE subscription backed by one or more in-memory event
 * emitters. It registers the listener(s) FIRST (so nothing is missed while an
 * optional `prelude` runs a catch-up query), then streams events as they arrive,
 * tagging each with a tracking id, and always unsubscribes on abort/return.
 *
 * Collapses what used to be a copy-pasted generator per subscription, including
 * the subtle abort-listener bookkeeping.
 */
export async function* eventStream<TEvent>(
  signal: AbortSignal | undefined,
  register: (push: (event: TEvent) => void) => () => void,
  makeId: (event: TEvent, index: number) => string,
  prelude?: () => AsyncIterable<{ id: string; data: TEvent }>
) {
  const queue: TEvent[] = [];
  let resolveWait: (() => void) | null = null;

  const unsubscribe = register((event) => {
    queue.push(event);
    resolveWait?.();
  });

  try {
    // Catch-up runs after registration so live events arriving during the query
    // are buffered in `queue` rather than dropped.
    if (prelude) {
      for await (const { id, data } of prelude()) {
        yield tracked(id, data);
      }
    }

    let index = 0;
    while (!signal?.aborted) {
      if (queue.length > 0) {
        const event = queue.shift()!;
        yield tracked(makeId(event, index++), event);
      } else {
        await new Promise<void>((resolve) => {
          const onAbort = () => resolve();
          resolveWait = () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
    }
  } finally {
    unsubscribe();
  }
}

export const sseRouter = router({
  // Subscribe to new messages for a session.
  // Optionally accepts afterSequence to catch up on missed messages on (re)connect.
  // Partial messages (id starting with "partial-") get a per-emit tracking id so
  // tRPC doesn't dedupe successive updates to the same streaming partial.
  onNewMessage: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        afterSequence: z.number().int().optional(),
      })
    )
    .subscription(({ input, signal }) =>
      eventStream<NewMessageWireEvent>(
        signal,
        (push) =>
          sseEvents.onNewMessage(input.sessionId, (event) =>
            push({
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
            })
          ),
        (event, index) =>
          event.message.id.startsWith('partial-')
            ? `${event.message.id}-${index}`
            : event.message.id,
        async function* () {
          if (input.afterSequence === undefined) return;
          const missed = await prisma.message.findMany({
            where: { sessionId: input.sessionId, sequence: { gt: input.afterSequence } },
            orderBy: { sequence: 'asc' },
          });
          for (const msg of missed) {
            yield {
              id: msg.id,
              data: {
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
              },
            };
          }
        }
      )
    ),

  // Subscribe to all latest-state events for a session over a single stream:
  // session updates, Claude running state, rate-limit retry status, and slash
  // commands. The client routes on `event.type`. Keeping these on one stream
  // (instead of four) avoids exhausting the browser's per-origin connection cap.
  onSessionEvents: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .subscription(({ input, signal }) =>
      eventStream<SessionStateEvent>(
        signal,
        (push) => {
          const unsubs = [
            sseEvents.onSessionUpdate(input.sessionId, push),
            sseEvents.onClaudeRunning(input.sessionId, push),
            sseEvents.onRetryStatus(input.sessionId, push),
            sseEvents.onCommands(input.sessionId, push),
          ];
          return () => unsubs.forEach((unsub) => unsub());
        },
        (event, index) => `${input.sessionId}-${event.type}-${index}`
      )
    ),

  // Subscribe to PR status updates for a session (used per-row on the session list).
  onPrUpdate: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .subscription(({ input, signal }) =>
      eventStream<PrUpdateEvent>(
        signal,
        (push) => sseEvents.onPrUpdate(input.sessionId, push),
        (event, index) => `${event.sessionId}-pr-${index}`
      )
    ),
});
