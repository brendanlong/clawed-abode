import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { sseEvents } from '../services/events';
import type { SessionStreamEvent, SessionListEvent } from '../services/events';
import { tracked } from '@trpc/server';
import { prisma } from '@/lib/prisma';
import { isPartialMessageId } from '@/lib/message-cache';
import { formatResumeToken, parseResumeToken, EMPTY_WATERMARK } from '@/lib/sse-resume';

/**
 * Yielded on either stream after the server dropped buffered events (see
 * {@link createEventQueue}). Clients must refetch every live query; on the
 * per-session stream the server has already replayed the persisted messages it
 * dropped, so only latest-value state is stale.
 */
type ResyncEvent = { kind: 'resync' };

export type SessionListStreamEvent = SessionListEvent | ResyncEvent;

/**
 * Most events buffered for one subscriber before the buffer is discarded and
 * replaced by a single `resync`. The generator only pulls when the response
 * stream has capacity, so a stalled SSE consumer would otherwise grow the buffer
 * without limit.
 */
export const MAX_QUEUED_EVENTS = 1000;

/**
 * Eagerly subscribe to an event source and buffer events into a queue. Subscribing
 * synchronously (rather than on the first generator `next()`) ensures events that
 * arrive while we replay history are not missed.
 *
 * The buffer is bounded: past `maxQueued` it is emptied, further events are
 * dropped, and `takeOverflow` reports `true` once so the consumer can resync;
 * buffering resumes from that point.
 */
export function createEventQueue<T>(
  subscribe: (push: (event: T) => void) => () => void,
  maxQueued = MAX_QUEUED_EVENTS
) {
  const queue: T[] = [];
  let overflowed = false;
  let resolveWait: (() => void) | null = null;
  const unsubscribe = subscribe((event) => {
    if (!overflowed) {
      if (queue.length < maxQueued) {
        queue.push(event);
      } else {
        queue.length = 0;
        overflowed = true;
      }
    }
    resolveWait?.();
  });
  const takeOverflow = (): boolean => {
    const result = overflowed;
    overflowed = false;
    return result;
  };
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
  return { queue, takeOverflow, waitForEvent, unsubscribe };
}

async function loadMessagesAfter(sessionId: string, floor: number) {
  const missed = await prisma.message.findMany({
    where: { sessionId, sequence: { gt: floor } },
    orderBy: { sequence: 'asc' },
  });
  return missed.map((msg) => ({ ...msg, content: JSON.parse(msg.content) as unknown }));
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

      const track = (event: SessionStreamEvent | ResyncEvent) => {
        // Only persisted (complete) messages advance the resume watermark.
        if (event.kind === 'message' && !isPartialMessageId(event.message.id)) {
          watermark = event.message.sequence;
        }
        return tracked(formatResumeToken(watermark, ++counter), event);
      };

      // Subscribe before any awaits so we don't miss live events during replay.
      const { queue, takeOverflow, waitForEvent, unsubscribe } =
        createEventQueue<SessionStreamEvent>((push) =>
          sseEvents.onSessionEvents(input.sessionId, push)
        );

      try {
        if (replayFloor !== undefined) {
          for (const message of await loadMessagesAfter(input.sessionId, replayFloor)) {
            yield track({ kind: 'message', message });
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
          if (takeOverflow()) {
            // The dropped events may have included persisted messages: replay them
            // from the watermark (the client dedupes by id), then tell the client
            // to refetch the latest-value state that can't be replayed.
            for (const message of await loadMessagesAfter(input.sessionId, watermark)) {
              yield track({ kind: 'message', message });
            }
            yield track({ kind: 'resync' });
          } else if (queue.length > 0) {
            yield track(queue.shift()!);
          } else {
            await waitForEvent(signal);
          }
        }
      } finally {
        unsubscribe();
      }
    }),

  // Global stream of session changes for the home page (all sessions): session
  // record updates plus main-agent running-state changes (running/waiting). The
  // list is small and also refetched on reconnect, so we only need monotonic
  // tracked ids (seeded from lastEventId) to avoid client-side dedup dropping the
  // first event.
  onSessionListEvents: protectedProcedure
    .input(z.object({ lastEventId: z.string().nullish() }).optional())
    .subscription(async function* ({ input, signal }) {
      // Guard against Number(null) === 0: only seed from a non-empty id.
      const seeded = input?.lastEventId ? Number(input.lastEventId) : NaN;
      let counter = Number.isInteger(seeded) ? seeded + 1 : 0;
      const track = (event: SessionListStreamEvent) => tracked(String(counter++), event);

      const { queue, takeOverflow, waitForEvent, unsubscribe } = createEventQueue<SessionListEvent>(
        (push) => sseEvents.onSessionListChanged(push)
      );

      try {
        while (!signal?.aborted) {
          if (takeOverflow()) {
            yield track({ kind: 'resync' });
          } else if (queue.length > 0) {
            yield track(queue.shift()!);
          } else {
            await waitForEvent(signal);
          }
        }
      } finally {
        unsubscribe();
      }
    }),
});
