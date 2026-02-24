import { parseAuthHeader, IDLE_TIMEOUT_MS } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/**
 * Verify authentication for Next.js API routes.
 * Extracts the Bearer token from the Authorization header or cookie,
 * validates it against the database, and checks expiration/idle timeout.
 *
 * Returns true if authenticated, false otherwise.
 */
export async function verifyApiAuth(req: Request): Promise<boolean> {
  const authHeader = req.headers.get('authorization');
  const token = parseAuthHeader(authHeader);

  if (!token) {
    return false;
  }

  const session = await prisma.authSession.findUnique({
    where: { token },
    select: { id: true, expiresAt: true, lastActivityAt: true, revokedAt: true },
  });

  if (!session) {
    return false;
  }

  const now = new Date();

  if (session.revokedAt) {
    return false;
  }

  if (session.expiresAt < now) {
    return false;
  }

  const idleTime = now.getTime() - session.lastActivityAt.getTime();
  if (idleTime > IDLE_TIMEOUT_MS) {
    return false;
  }

  return true;
}
