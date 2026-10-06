import { prisma } from '@/lib/prisma';
import {
  ACTIVITY_UPDATE_THROTTLE_MS,
  AUTH_SESSION_RETENTION_MS,
  SESSION_DURATION_MS,
  effectiveExpiry,
  generateSessionToken,
  liveSessionWhere,
  type AuthScope,
} from '@/lib/auth';
import { createLogger } from '@/lib/logger';

const log = createLogger('auth-sessions');

export interface ClientInfo {
  ipAddress?: string;
  userAgent?: string;
}

export async function createAuthSession(client: ClientInfo, scope: AuthScope): Promise<string> {
  const token = generateSessionToken();
  await prisma.authSession.create({
    data: {
      token,
      scope,
      expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
      ipAddress: client.ipAddress,
      userAgent: client.userAgent,
    },
  });
  return token;
}

/**
 * Turn the first live `public_files` session among `tokens` (the browser's
 * public cookie values) into a `full` one after a password login, so it stays
 * one entry in the session list. The token is replaced, as on any privilege
 * change. Returns the new token, or null if none qualified. Each attempt is one
 * conditional statement, so a concurrent revoke can't be overwritten.
 */
export async function upgradePublicFilesSession(
  tokens: string[],
  client: ClientInfo
): Promise<string | null> {
  for (const token of tokens) {
    const now = new Date();
    const newToken = generateSessionToken();
    const { count } = await prisma.authSession.updateMany({
      where: { token, scope: 'public_files', ...liveSessionWhere(now) },
      data: {
        token: newToken,
        scope: 'full',
        expiresAt: new Date(now.getTime() + SESSION_DURATION_MS),
        lastActivityAt: now,
        ipAddress: client.ipAddress,
        userAgent: client.userAgent,
      },
    });
    if (count === 1) return newToken;
  }
  return null;
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
 * The auth session a token belongs to, or null when it is unknown, revoked,
 * expired, idle, or lacks the scope. `full` is accepted everywhere; `public_files`
 * only where `scope` is `public_files`. Shared by the Authorization header (tRPC,
 * upload) and the public-files cookie so both enforce the same rules.
 */
export async function resolveAuthSessionId(
  token: string,
  scope: AuthScope
): Promise<string | null> {
  const session = await prisma.authSession.findUnique({
    where: { token },
    select: { id: true, scope: true, expiresAt: true, lastActivityAt: true, revokedAt: true },
  });

  if (!session || session.revokedAt) {
    return null;
  }
  if (scope === 'full' && session.scope !== 'full') return null;

  const now = new Date();

  // Expired or idle: reject, but keep the row for the audit list.
  if (effectiveExpiry(session) < now) {
    const idle = session.expiresAt >= now; // still within its absolute lifetime
    if (idle) log.info('Session rejected due to idle timeout', { sessionId: session.id });
    return null;
  }

  // Update last activity (throttled to avoid excessive DB writes)
  if (now.getTime() - session.lastActivityAt.getTime() > ACTIVITY_UPDATE_THROTTLE_MS) {
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
