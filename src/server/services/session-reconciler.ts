/**
 * Session reconciliation for server startup.
 *
 * In the new architecture (no containers/processes), reconciliation is simple:
 * on server restart, all in-memory session state is lost, so any session
 * marked as "running" should be marked "stopped". The user can restart
 * sessions manually.
 */

import { markAllSessionsStopped } from './claude-runner';
import { createLogger, toError } from '@/lib/logger';

const log = createLogger('session-reconciler');

/**
 * Result of reconciling sessions on startup.
 */
export interface ReconciliationResult {
  sessionsMarkedStopped: number;
}

/**
 * Reconcile all sessions on startup.
 * Since sessions run in-process, any "running" session from a previous
 * server instance is now dead and should be marked stopped.
 */
export async function reconcileSessions(): Promise<ReconciliationResult> {
  log.info('Reconciling sessions on startup');

  try {
    const count = await markAllSessionsStopped();

    const result = { sessionsMarkedStopped: count };
    log.info('Session reconciliation complete', result);
    return result;
  } catch (error) {
    log.error('Session reconciliation failed', toError(error));
    throw error;
  }
}
