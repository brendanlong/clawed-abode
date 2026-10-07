/**
 * The "needs you" flag on a session (doc/claude-sessions.md, "Needs You"): set
 * when the agent asks for the user, cleared once the user has seen the session.
 */

import { prisma } from '@/lib/prisma';
import { createLogger, toError } from '@/lib/logger';
import { sseEvents } from './events';

const log = createLogger('session-attention');

export async function requestAttention(sessionId: string, summary: string): Promise<void> {
  const [row] = await prisma.session.updateManyAndReturn({
    where: { id: sessionId, status: { not: 'archived' } },
    data: { attentionAt: new Date(), attentionSummary: summary },
  });
  if (!row) return;
  sseEvents.emitSessionUpdate(sessionId, row);
  sseEvents.emitAttention(sessionId, row.name, summary);
}

/** Best-effort, like the activity bump it accompanies: a stale badge beats a failed send. */
export async function clearAttention(sessionId: string): Promise<void> {
  try {
    const [row] = await prisma.session.updateManyAndReturn({
      where: { id: sessionId, attentionAt: { not: null } },
      data: { attentionAt: null, attentionSummary: null },
    });
    if (row) sseEvents.emitSessionUpdate(sessionId, row);
  } catch (err) {
    log.warn('Failed to clear session attention', { sessionId, error: toError(err).message });
  }
}
