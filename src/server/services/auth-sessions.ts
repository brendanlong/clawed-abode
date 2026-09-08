import { prisma } from '@/lib/prisma';
import { AUTH_SESSION_RETENTION_MS, SESSION_DURATION_MS, generateSessionToken } from '@/lib/auth';
import { createLogger } from '@/lib/logger';

const log = createLogger('auth-sessions');

export async function createAuthSession(ipAddress?: string, userAgent?: string): Promise<string> {
  const token = generateSessionToken();
  await prisma.authSession.create({
    data: { token, expiresAt: new Date(Date.now() + SESSION_DURATION_MS), ipAddress, userAgent },
  });
  return token;
}

/**
 * Delete auth sessions that have been expired or revoked for longer than the
 * retention window. Idle-expired sessions are covered too: their absolute
 * `expiresAt` is at most SESSION_DURATION_MS after creation. Runs at boot and
 * on each login so the table stays bounded without a timer.
 */
export async function purgeInactiveAuthSessions(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - AUTH_SESSION_RETENTION_MS);
  const { count } = await prisma.authSession.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
  });
  if (count > 0) log.info('Purged inactive auth sessions', { count });
  return count;
}
