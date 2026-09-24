import { prisma } from '@/lib/prisma';
import {
  ACTIVITY_UPDATE_THROTTLE_MS,
  AUTH_SESSION_RETENTION_MS,
  IDLE_TIMEOUT_MS,
  SESSION_DURATION_MS,
  generateSessionToken,
} from '@/lib/auth';
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

/**
 * The auth session a bearer token belongs to, or null when it is unknown,
 * revoked, expired, or idle. Shared by the Authorization header (tRPC, upload)
 * and the public-files cookie so both enforce the same rules.
 */
export async function resolveAuthSessionId(token: string): Promise<string | null> {
  const session = await prisma.authSession.findUnique({
    where: { token },
    select: { id: true, expiresAt: true, lastActivityAt: true, revokedAt: true },
  });

  if (!session || session.revokedAt) {
    return null;
  }

  const now = new Date();

  if (session.expiresAt < now) {
    return null;
  }

  // Check for idle timeout
  const idleTime = now.getTime() - session.lastActivityAt.getTime();
  if (idleTime > IDLE_TIMEOUT_MS) {
    // Session is idle, reject it (but don't delete - keep for audit/display)
    log.info('Session rejected due to idle timeout', { sessionId: session.id });
    return null;
  }

  // Update last activity (throttled to avoid excessive DB writes)
  if (idleTime > ACTIVITY_UPDATE_THROTTLE_MS) {
    prisma.authSession
      .update({
        where: { id: session.id },
        data: { lastActivityAt: now },
      })
      .catch(() => {
        // Fire and forget - don't fail the request if activity update fails
      });
  }

  return session.id;
}
