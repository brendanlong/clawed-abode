/**
 * Pure derivation of the status label shown for a session in the session list.
 *
 * A DB status of `running` only means the session is live (workspace exists,
 * query available). Whether Claude is actually busy is two independent live axes
 * (see `session-status.ts`): `turnActive` (the main agent is mid-turn) and
 * background tasks (subagents / Monitor / backgrounded Bash that outlive a turn).
 * The list splits a live `running` session into:
 *
 *   - `running`    — the main agent is mid-turn generating (regardless of any
 *                    background tasks)
 *   - `background` — the main agent is idle but a background task/subagent is
 *                    still running
 *   - `waiting`    — the session is live and fully idle, waiting for user input
 *
 * All other statuses pass through unchanged.
 */
export type SessionDisplayStatus =
  | 'running'
  | 'background'
  | 'waiting'
  | 'stopped'
  | 'creating'
  | 'error'
  | 'archived';

export function deriveSessionDisplayStatus(
  status: string,
  turnActive: boolean,
  backgroundActive = false
): string {
  if (status === 'running') {
    if (turnActive) return 'running';
    if (backgroundActive) return 'background';
    return 'waiting';
  }
  return status;
}
