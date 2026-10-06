import type { SessionStatus } from './session-display-status';

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
 * Stop is not allowed from `creating`: setup would mark the session running
 * once the clone finishes anyway, and a stop that won would strand a session
 * whose `repoPath` was never recorded.
 */
export const ALLOWED_FROM: Record<SessionTransition, readonly SessionStatus[]> = {
  setupProgress: ['creating'],
  setupComplete: ['creating'],
  setupFailed: ['creating'],
  start: ['stopped', 'error'],
  stop: ['running', 'stopped', 'error'],
  archive: ['creating', 'running', 'stopped', 'error'],
  configure: ['creating', 'running', 'stopped', 'error'],
};
