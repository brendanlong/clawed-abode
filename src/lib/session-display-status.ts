import { z } from 'zod';

/** Statuses stored on `Session.status`. */
export const sessionStatusSchema = z.enum(['creating', 'running', 'stopped', 'error', 'archived']);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/**
 * Status label shown for a session in the session list and header.
 *
 * A DB status of `running` only means the session is live (workspace exists,
 * query available). Whether Claude is actually busy is two independent live axes
 * (see `session-status.ts`): `turnActive` (the main agent is mid-turn) and
 * background tasks (subagents / Monitor / backgrounded Bash that outlive a turn).
 * A live `running` session splits into:
 *
 *   - `running`    — the main agent is mid-turn generating (regardless of any
 *                    background tasks)
 *   - `background` — the main agent is idle but a background task/subagent is
 *                    still running
 *   - `paused`     — idle because a subscription usage limit parked its work; it
 *                    resumes on its own when the window resets
 *   - `waiting`    — the session is live and fully idle, waiting for user input
 *
 * A rate-limit pause ranks below the two busy axes: it never interrupts a turn,
 * so a session finishing one under a pause still reads as busy.
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
