import { sessionStatusSchema, type SessionStatus } from './session-display-status';

/** Every lifecycle write to a session row, named by intent. */
export type SessionTransition =
  | 'setupProgress'
  | 'setupComplete'
  | 'setupFailed'
  | 'start'
  | 'stop'
  | 'archive'
  /** Not a status change: a settings write that an archived (read-only) session refuses. */
  | 'configure';

/**
 * The statuses each transition may be applied from. Writes are conditional on
 * this set in the same statement (never read-check-then-write), so a concurrent
 * archive can't be overwritten by a stop, start, or a setup that finishes late.
 *
 * `error` means setup failed: there is no workspace or `repoPath`, so the only
 * way out is archive — starting it (directly, or via stop → start) would run
 * an agent with nothing to work in. Stop is not allowed from `creating` for the
 * same reason: setup would mark the session running once the clone finishes
 * anyway, and a stop that won would strand a session with no `repoPath`.
 */
export const ALLOWED_FROM: Record<SessionTransition, readonly SessionStatus[]> = {
  setupProgress: ['creating'],
  setupComplete: ['creating'],
  setupFailed: ['creating'],
  start: ['stopped'],
  stop: ['running'],
  archive: ['creating', 'running', 'stopped', 'error'],
  configure: ['creating', 'running', 'stopped', 'error'],
};

/** Whether `transition` applies to a session currently in `status`. */
export function canTransition(transition: SessionTransition, status: string): boolean {
  const parsed = sessionStatusSchema.safeParse(status);
  return parsed.success && ALLOWED_FROM[transition].includes(parsed.data);
}
