import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { AUTH_SESSION_RETENTION_MS, IDLE_TIMEOUT_MS, SESSION_DURATION_MS } from '@/lib/auth';

vi.mock('@/lib/logger', async () => (await import('@/test/mock-logger')).mockLoggerModule());

let purgeInactiveAuthSessions: (typeof import('./auth-sessions'))['purgeInactiveAuthSessions'];

const DAY_MS = 24 * 60 * 60 * 1000;

let sessions: typeof import('./auth-sessions');

beforeAll(async () => {
  await setupTestDb();
  sessions = await import('./auth-sessions');
  ({ purgeInactiveAuthSessions } = sessions);
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearTestDb();
});

describe('purgeInactiveAuthSessions', () => {
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

describe('auth session scopes', () => {
  const client = { ipAddress: '100.64.0.1', userAgent: 'phone' };

  it('accepts a full session everywhere and a public-files session only for public files', async () => {
    const full = await sessions.createAuthSession(client, 'full');
    const publicOnly = await sessions.createAuthSession(client, 'public_files');

    expect(await sessions.resolveAuthSessionId(full, 'full')).not.toBeNull();
    expect(await sessions.resolveAuthSessionId(full, 'public_files')).not.toBeNull();
    expect(await sessions.resolveAuthSessionId(publicOnly, 'public_files')).not.toBeNull();
    expect(await sessions.resolveAuthSessionId(publicOnly, 'full')).toBeNull();
  });

  it('upgrades a live public-files session in place, replacing its token', async () => {
    const oldToken = await sessions.createAuthSession({}, 'public_files');
    const { id } = await testPrisma.authSession.findUniqueOrThrow({ where: { token: oldToken } });

    const newToken = await sessions.upgradePublicFilesSession(['planted', oldToken], client);

    expect(newToken).not.toBeNull();
    expect(newToken).not.toBe(oldToken);
    expect(await sessions.resolveAuthSessionId(newToken!, 'full')).toBe(id);
    expect(await sessions.resolveAuthSessionId(oldToken, 'public_files')).toBeNull();
    expect(await testPrisma.authSession.findUnique({ where: { id } })).toMatchObject(client);
  });

  it('does not upgrade full, revoked, expired, idle, or unknown sessions', async () => {
    const now = Date.now();
    const live = new Date(now + SESSION_DURATION_MS);
    const rows = [
      { token: 'full', scope: 'full', expiresAt: live },
      { token: 'revoked', scope: 'public_files', expiresAt: live, revokedAt: new Date() },
      { token: 'expired', scope: 'public_files', expiresAt: new Date(now - 1000) },
      {
        token: 'idle',
        scope: 'public_files',
        expiresAt: live,
        lastActivityAt: new Date(now - IDLE_TIMEOUT_MS - 1000),
      },
    ];
    for (const data of rows) await testPrisma.authSession.create({ data });

    for (const token of [...rows.map((r) => r.token), 'unknown']) {
      expect(await sessions.upgradePublicFilesSession([token], client)).toBeNull();
    }
    expect(await testPrisma.authSession.count({ where: { scope: 'full' } })).toBe(1);
  });
});
