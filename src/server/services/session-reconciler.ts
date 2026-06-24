/**
 * Session reconciliation for server startup.
 *
 * With one long-lived streaming query per session, a server restart loses the
 * in-memory query but NOT the session's intent: a session in DB status `running`
 * stays `running` and is revived lazily (with `resume`) on the next interaction
 * via `ensureSessionQuery`. So startup no longer force-stops anything — it only
 * reports how many running sessions will be revived on demand.
 *
 * Caveat: a background task that was mid-flight when the server died cannot be
 * resurrected (its subprocess is gone); recovery restores the conversation, not
 * in-flight background work.
 */

import { prisma } from '@/lib/prisma';
import { createLogger, toError } from '@/lib/logger';

const log = createLogger('session-reconciler');

export interface ReconciliationResult {
  /** Sessions left `running` for lazy revive on next interaction. */
  runningSessionsToRevive: number;
}

/**
 * Reconcile sessions on startup. No DB mutation: running sessions are revived
 * lazily, so this just counts them for an informative startup log.
 */
export async function reconcileSessions(): Promise<ReconciliationResult> {
  log.info('Reconciling sessions on startup');

  try {
    const runningSessionsToRevive = await prisma.session.count({ where: { status: 'running' } });
    const result = { runningSessionsToRevive };
    log.info('Session reconciliation complete', result);
    return result;
  } catch (error) {
    log.error('Session reconciliation failed', toError(error));
    throw error;
  }
}
