/**
 * In-memory rendezvous for attachments on a session's initial prompt.
 *
 * A new session's workspace only exists after `sessions.create` starts cloning
 * in the background, so the client can only upload the initial prompt's files
 * *after* the session row exists. But the initial prompt is sent server-side
 * once the clone completes (so it survives a client disconnect). This module
 * bridges the two: `create` reserves a slot, the client registers the uploaded
 * stored names once available, and the background setup awaits them (with a
 * timeout) before sending the prompt with attachment paths.
 *
 * The common ordering is register-before-await (upload is fast; the clone that
 * gates the await is slow), so `resolve` almost always lands first and the
 * background's `await` returns immediately. The timeout covers the rare case
 * where the client abandons the flow after `create` — the prompt is then sent
 * without attachments rather than hanging forever.
 */

interface Reservation {
  promise: Promise<string[]>;
  resolve: (storedNames: string[]) => void;
}

const reservations = new Map<string, Reservation>();

/**
 * Reserve a rendezvous slot for a session whose initial prompt will carry
 * attachments. Called from `create` before the background setup starts, so the
 * slot exists whether the client registers or the background awaits first.
 * Idempotent: re-reserving keeps the existing (possibly already-resolved) slot.
 */
export function reserveInitialAttachments(sessionId: string): void {
  if (reservations.has(sessionId)) return;
  let resolve!: (storedNames: string[]) => void;
  const promise = new Promise<string[]>((r) => {
    resolve = r;
  });
  reservations.set(sessionId, { promise, resolve });
}

/**
 * Register the uploaded attachment stored names for a session's initial prompt,
 * unblocking the background setup's `await`. A no-op if no slot was reserved
 * (e.g. the session had no initial attachments) or it was already resolved.
 */
export function resolveInitialAttachments(sessionId: string, storedNames: string[]): void {
  reservations.get(sessionId)?.resolve(storedNames);
}

/**
 * Await the registered attachment stored names for a session, up to `timeoutMs`.
 * Returns the stored names once registered, or an empty array if the timeout
 * elapses first (the client never registered). Consumes the slot.
 */
export async function awaitInitialAttachments(
  sessionId: string,
  timeoutMs: number
): Promise<string[]> {
  const reservation = reservations.get(sessionId);
  if (!reservation) return [];

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve([]), timeoutMs);
  });

  try {
    return await Promise.race([reservation.promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    reservations.delete(sessionId);
  }
}

/**
 * Drop a session's reservation without awaiting it. Used to clean up when the
 * background setup fails before it reaches the await (e.g. the clone throws).
 */
export function clearInitialAttachments(sessionId: string): void {
  reservations.delete(sessionId);
}
