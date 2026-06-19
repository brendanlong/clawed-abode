import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { sseEvents } from '../services/events';
import type { SessionStreamEvent, SessionUpdateEvent } from '../services/events';
import { tracked } from '@trpc/server';
import { prisma } from '@/lib/prisma';
import { isPartialMessageId } from '@/lib/message-cache';
import { formatResumeToken, parseResumeToken, EMPTY_WATERMARK } from '@/lib/sse-resume';

/**
 * Eagerly subscribe to an event source and buffer events into a queue. Subscribing
 * synchronously (rather than on the first generator `next()`) ensures events that
 * arrive while we replay history are not missed.
 */
function createEventQueue<T>(subscribe: (push: (event: T) => void) => () => void) {
  const queue: T[] = [];
  let resolveWait: (() => void) | null = null;
  const unsubscribe = subscribe((event) => {
    queue.push(event);
    resolveWait?.();
  });
  const waitForEvent = (signal: AbortSignal | undefined): Promise<void> =>
    new Promise<void>((resolve) => {
      // If already aborted, the 'abort' event has fired and won't fire again,
      // so resolve synchronously to avoid hanging the generator.
      if (signal?.aborted) {
        resolve();
        return;
      }
      const onAbort = () => resolve();
      resolveWait = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  return { queue, waitForEvent, unsubscribe };
}

export const sseRouter = router({
  // Single multiplexed stream of all event kinds for one session.
  //
  // Catch-up uses a replay floor: messages with `sequence > floor` are replayed
  // before live streaming begins. The floor comes from one of two places:
  //   - `lastEventId` — supplied by tRPC automatically on reconnect (from the SSE
  //     `Last-Event-ID` header); its token encodes the high-water mark.
  //   - `afterSequence` — the client's newest cached message sequence, captured
  //     once at mount and sent on the *initial* connect (no lastEventId yet). This
  //     closes the window between the client's `getHistory` snapshot and the stream
  //     attaching, during which messages could otherwise be missed by both paths.
  // With neither, we anchor at the current max (nothing to replay).
  //
  // Non-message events are "latest value" and are resynced by the client's React
  // Query refetch — they are streamed live but never replayed.
  onSessionEvents: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        afterSequence: z.number().int().optional(),
        lastEventId: z.string().nullish(),
      })
    )
    .subscription(async function* ({ input, signal }) {
      const resume = parseResumeToken(input.lastEventId);
      let counter = resume?.counter ?? 0;

      // Replay floor: lastEventId (reconnect) takes precedence over the initial
      // afterSequence anchor; with neither we don't replay.
      const replayFloor = resume ? resume.watermark : input.afterSequence;
      let watermark = replayFloor ?? EMPTY_WATERMARK;

      // Subscribe before any awaits so we don't miss live events during replay.
      const { queue, waitForEvent, unsubscribe } = createEventQueue<SessionStreamEvent>((push) =>
        sseEvents.onSessionEvents(input.sessionId, push)
      );

      try {
        if (replayFloor !== undefined) {
          // Replay messages persisted since the client's last known sequence.
          const missed = await prisma.message.findMany({
            where: { sessionId: input.sessionId, sequence: { gt: replayFloor } },
            orderBy: { sequence: 'asc' },
          });
          for (const msg of missed) {
            watermark = msg.sequence;
            yield tracked(formatResumeToken(watermark, ++counter), {
              kind: 'message' as const,
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
        } else {
          // No catch-up requested: anchor the watermark at the current max so a
          // later reconnect replays only messages created from here on.
          const last = await prisma.message.findFirst({
            where: { sessionId: input.sessionId },
            orderBy: { sequence: 'desc' },
            select: { sequence: true },
          });
          watermark = last?.sequence ?? EMPTY_WATERMARK;
        }

        while (!signal?.aborted) {
          if (queue.length > 0) {
            const event = queue.shift()!;
            // Only persisted (complete) messages advance the resume watermark.
            if (event.kind === 'message' && !isPartialMessageId(event.message.id)) {
              watermark = event.message.sequence;
            }
            yield tracked(formatResumeToken(watermark, ++counter), event);
          } else {
            await waitForEvent(signal);
          }
        }
      } finally {
        unsubscribe();
      }
    }),

  // Global stream of session changes for the home page (all sessions). The list is
  // small and also refetched on reconnect, so we only need monotonic tracked ids
  // (seeded from lastEventId) to avoid client-side dedup dropping the first event.
  onSessionListEvents: protectedProcedure
    .input(z.object({ lastEventId: z.string().nullish() }).optional())
    .subscription(async function* ({ input, signal }) {
      // Guard against Number(null) === 0: only seed from a non-empty id.
      const seeded = input?.lastEventId ? Number(input.lastEventId) : NaN;
      let counter = Number.isInteger(seeded) ? seeded + 1 : 0;

      const { queue, waitForEvent, unsubscribe } = createEventQueue<SessionUpdateEvent>((push) =>
        sseEvents.onSessionListChanged(push)
      );

      try {
        while (!signal?.aborted) {
          if (queue.length > 0) {
            const event = queue.shift()!;
            yield tracked(String(counter++), {
              kind: 'session' as const,
              session: event.session,
            });
          } else {
            await waitForEvent(signal);
          }
        }
      } finally {
        unsubscribe();
      }
    }),
});
