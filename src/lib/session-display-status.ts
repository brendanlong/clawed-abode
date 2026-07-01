/**
 * Pure derivation of the status label shown for a session in the session list.
 *
 * A DB status of `running` only means the session is live (workspace exists,
 * query available) — whether Claude is actually generating is the independent
 * `turnActive` axis (see `session-status.ts`). The list splits `running` into:
 *
 *   - `running` — the main agent is mid-turn generating
 *   - `waiting` — the session is live but idle, waiting for user input
 *
 * All other statuses pass through unchanged.
 */
export type SessionDisplayStatus =
  | 'running'
  | 'waiting'
  | 'stopped'
  | 'creating'
  | 'error'
  | 'archived';

export function deriveSessionDisplayStatus(status: string, turnActive: boolean): string {
  if (status === 'running') {
    return turnActive ? 'running' : 'waiting';
  }
  return status;
}
