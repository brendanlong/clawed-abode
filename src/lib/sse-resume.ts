/**
 * Resume-token helpers for the multiplexed per-session SSE stream.
 *
 * The stream carries a union of event kinds, but only persisted messages are
 * replayable on reconnect (they have monotonic `sequence` numbers). The single
 * `tracked()` id therefore encodes two things:
 *
 * - `watermark`: the highest persisted message sequence yielded so far on this
 *   connection. On reconnect the server replays `message.sequence > watermark`.
 * - `counter`: a per-connection value that strictly increases for every yielded
 *   event (seeded from the previous `lastEventId` on reconnect). Because tRPC
 *   drops events whose tracked id repeats, the counter guarantees uniqueness even
 *   when several events share the same watermark.
 *
 * Token format: `${watermark}:${counter}` — e.g. `42:7`.
 *
 * `-1` is the watermark used when a session has no persisted messages yet
 * (sequences start at 0), so `sequence > -1` replays everything.
 */

export interface ResumeToken {
  watermark: number;
  counter: number;
}

/** Watermark used before any message has been persisted (sequences start at 0). */
export const EMPTY_WATERMARK = -1;

export function formatResumeToken(watermark: number, counter: number): string {
  return `${watermark}:${counter}`;
}

/**
 * Parse a `lastEventId` produced by {@link formatResumeToken}. Returns `null` for
 * a missing or malformed token (e.g. a fresh connection, or an id from an older
 * format), in which case the caller should start from the current high-water mark
 * without replaying.
 */
export function parseResumeToken(token: string | null | undefined): ResumeToken | null {
  if (!token) return null;

  const parts = token.split(':');
  if (parts.length !== 2) return null;

  const watermark = Number(parts[0]);
  const counter = Number(parts[1]);
  if (!Number.isInteger(watermark) || !Number.isInteger(counter)) return null;

  return { watermark, counter };
}
