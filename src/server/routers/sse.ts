import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { sseEvents } from '../services/events';
import type { SessionStreamEvent, SessionListEvent } from '../services/events';
import { TRPCError, tracked } from '@trpc/server';
import { loadSessionSnapshot, type SessionSnapshot } from '../services/session-snapshot';
import { isPartialMessageId } from '@/lib/message-cache';
import { formatResumeToken, parseResumeToken, EMPTY_WATERMARK } from '@/lib/sse-resume';

/**
 * Yielded on the session-list stream after the server dropped buffered events
 * (see {@link createEventQueue}); the client refetches the list.
 */
type ResyncEvent = { kind: 'resync' };

export type SessionListStreamEvent = SessionListEvent | ResyncEvent;

/**
 * The per-session stream's first event on every (re)connect, and its answer to a
 * buffer overflow: the session row, every latest-value field, and the transcript
 * (see {@link loadSessionSnapshot}).
 */
type SessionSnapshotEvent = { kind: 'snapshot' } & SessionSnapshot;

export type SessionStreamOutput = SessionSnapshotEvent | SessionStreamEvent;

/**
 * Most events buffered for one subscriber before the buffer is discarded and
 * replaced by a single resync. The generator only pulls when the response
 * stream has capacity, so a stalled SSE consumer would otherwise grow the buffer
 * without limit.
 */
const MAX_QUEUED_EVENTS = 1000;

interface EventQueueOptions<T> {
  maxQueued?: number;
  /**
   * Events with the same key supersede each other: a new one drops the buffered one
   * and is appended, so it stays ordered after anything pushed in between. Used for
   * partial-message snapshots, which each carry the whole accumulated message, so a
   * stalled consumer holds one snapshot per stream rather than one per delta.
   */
  coalesceKey?: (event: T) => string | undefined;
}

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
  { maxQueued = MAX_QUEUED_EVENTS, coalesceKey }: EventQueueOptions<T> = {}
) {
  const queue: T[] = [];
  let overflowed = false;
  let resolveWait: (() => void) | null = null;
  const enqueue = (event: T) => {
    const key = coalesceKey?.(event);
    const existing = key === undefined ? -1 : queue.findIndex((e) => coalesceKey?.(e) === key);
    if (existing !== -1) {
      queue.splice(existing, 1);
      queue.push(event);
    } else if (queue.length < maxQueued) {
      queue.push(event);
    } else {
      queue.length = 0;
      overflowed = true;
    }
  };
  const unsubscribe = subscribe((event) => {
    if (!overflowed) enqueue(event);
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

const RESYNC: ResyncEvent = { kind: 'resync' };

/**
 * Yield buffered events until the subscription aborts, substituting one
 * `resync()` for anything the queue dropped.
 */
async function* drainEventQueue<T, R>(
  { queue, takeOverflow, waitForEvent }: ReturnType<typeof createEventQueue<T>>,
  signal: AbortSignal | undefined,
  resync: () => Promise<R>
): AsyncGenerator<T | R> {
  while (!signal?.aborted) {
    if (takeOverflow()) {
      yield await resync();
    } else if (queue.length > 0) {
      yield queue.shift()!;
    } else {
      await waitForEvent(signal);
    }
  }
}

const partialMessageKey = (event: SessionStreamEvent) =>
  event.kind === 'message' && isPartialMessageId(event.message.id) ? event.message.id : undefined;

export const sseRouter = router({
  // Single multiplexed stream of all event kinds for one session, self-sufficient:
  // the first event on every (re)connect is a snapshot, then deltas follow. We
  // subscribe before reading the snapshot, so anything that changes during the
  // read arrives afterwards as a delta — snapshot + deltas has no gap, and
  // re-applying a delta the snapshot already reflects is harmless (messages dedupe
  // by id, latest-value events converge on the last one).
  //
  // A fresh connection's snapshot carries the newest history page. A reconnect
  // (tRPC passes the last tracked id as `lastEventId`) resumes from that token's
  // watermark: the snapshot carries every message after it, plus fresh
  // latest-value state.
  onSessionEvents: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid(), lastEventId: z.string().nullish() }))
    .subscription(async function* ({ input, signal }) {
      const { sessionId } = input;
      const resume = parseResumeToken(input.lastEventId);
      let counter = resume?.counter ?? 0;
      let watermark = resume?.watermark ?? EMPTY_WATERMARK;

      const track = (event: SessionStreamOutput) => {
        // Only persisted (complete) messages advance the resume watermark. Max, not
        // assign: a rewritten row (markLastMessageAsInterrupted) re-emits its
        // original, older sequence.
        if (event.kind === 'message' && !isPartialMessageId(event.message.id)) {
          watermark = Math.max(watermark, event.message.sequence);
        } else if (event.kind === 'snapshot') {
          for (const message of event.history.messages) {
            watermark = Math.max(watermark, message.sequence);
          }
        }
        return tracked(formatResumeToken(watermark, ++counter), event);
      };

      const snapshot = async (resumeAfter: number | null): Promise<SessionSnapshotEvent> => {
        const loaded = await loadSessionSnapshot(sessionId, resumeAfter);
        if (!loaded) throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
        return { kind: 'snapshot', ...loaded };
      };

      // Subscribe before any awaits so nothing emitted during the snapshot read is missed.
      const events = createEventQueue<SessionStreamEvent>(
        (push) => sseEvents.onSessionEvents(sessionId, push),
        { coalesceKey: partialMessageKey }
      );

      try {
        yield track(await snapshot(resume ? watermark : null));
        // On overflow, a resumed-style snapshot: the dropped events may include a
        // `message_removed`, which only the snapshot's reconciled range can heal.
        const resync = () => snapshot(watermark);
        for await (const event of drainEventQueue(events, signal, resync)) yield track(event);
      } finally {
        events.unsubscribe();
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

      const events = createEventQueue<SessionListEvent>((push) =>
        sseEvents.onSessionListChanged(push)
      );
      try {
        const resync = async () => RESYNC;
        for await (const event of drainEventQueue(events, signal, resync)) yield track(event);
      } finally {
        events.unsubscribe();
      }
    }),
});
