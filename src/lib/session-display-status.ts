import { z } from 'zod';

/** Statuses stored on `Session.status`. */
export const sessionStatusSchema = z.enum(['creating', 'running', 'stopped', 'error', 'archived']);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/**
 * Status label shown for a session in the session list and header.
 *
 * A DB status of `running` only means the session is live; whether Claude is busy
 * is the two live axes of doc/claude-sessions.md "Two-Axis Status". A live
 * `running` session splits into:
 *
 *   - `running`    — the main agent is mid-turn generating (regardless of any
 *                    background tasks)
 *   - `background` — the main agent is idle but a background task/subagent is
 *                    still running
 *   - `paused`     — idle because a subscription usage limit parked its work; it
 *                    resumes on its own when the window resets
 *   - `waiting`    — the session is live and fully idle, waiting for user input
 *
 * A rate-limit pause ranks below the two busy axes: the pause interrupts the live
 * turn, and the session reads as busy until that turn has actually ended.
 *
 * All other stored statuses pass through unchanged.
 */
export type SessionDisplayStatus = SessionStatus | 'background' | 'waiting' | 'paused';

export function deriveSessionDisplayStatus(
  status: string,
  turnActive: boolean,
  backgroundActive = false,
  rateLimitPaused = false
): SessionDisplayStatus {
  const stored = sessionStatusSchema.safeParse(status);
  // A stored status this client doesn't know is itself an error condition.
  if (!stored.success) return 'error';
  if (stored.data === 'running') {
    if (turnActive) return 'running';
    if (backgroundActive) return 'background';
    if (rateLimitPaused) return 'paused';
    return 'waiting';
  }
  return stored.data;
}
