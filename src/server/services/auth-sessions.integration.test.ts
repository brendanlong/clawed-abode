import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { AUTH_SESSION_RETENTION_MS, SESSION_DURATION_MS } from '@/lib/auth';

vi.mock('@/lib/logger', async () => (await import('@/test/mock-logger')).mockLoggerModule());

let purgeInactiveAuthSessions: (typeof import('./auth-sessions'))['purgeInactiveAuthSessions'];

const DAY_MS = 24 * 60 * 60 * 1000;

describe('purgeInactiveAuthSessions', () => {
  beforeAll(async () => {
    await setupTestDb();
    ({ purgeInactiveAuthSessions } = await import('./auth-sessions'));
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  async function insert(name: string, data: { expiresAt: Date; revokedAt?: Date }) {
    return testPrisma.authSession.create({ data: { token: `token-${name}`, ...data } });
  }

  it('deletes only sessions expired or revoked for longer than the retention window', async () => {
    const now = new Date();
    const beyondRetention = new Date(now.getTime() - AUTH_SESSION_RETENTION_MS - DAY_MS);
    const withinRetention = new Date(now.getTime() - AUTH_SESSION_RETENTION_MS + DAY_MS);
    const live = new Date(now.getTime() + SESSION_DURATION_MS);

    await insert('long-expired', { expiresAt: beyondRetention });
    await insert('long-revoked', { expiresAt: live, revokedAt: beyondRetention });
    const recentlyExpired = await insert('recently-expired', { expiresAt: withinRetention });
    const recentlyRevoked = await insert('recently-revoked', { expiresAt: live, revokedAt: now });
    const active = await insert('active', { expiresAt: live });

    const purged = await purgeInactiveAuthSessions(now);

    expect(purged).toBe(2);
    const remaining = await testPrisma.authSession.findMany({ select: { id: true } });
    expect(remaining.map((s) => s.id).sort()).toEqual(
      [recentlyExpired.id, recentlyRevoked.id, active.id].sort()
    );
  });

  it('is a no-op on an empty table', async () => {
    expect(await purgeInactiveAuthSessions()).toBe(0);
  });
});
