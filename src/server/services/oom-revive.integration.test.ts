import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { createTestSession } from '@/test/fixtures';

let claimOomdRevive: typeof import('./oom-revive').claimOomdRevive;
let bumpSessionActivity: typeof import('./message-store').bumpSessionActivity;

describe('claimOomdRevive', () => {
  beforeAll(async () => {
    await setupTestDb();
    // After setupTestDb, so @/lib/prisma binds to the test database.
    ({ claimOomdRevive } = await import('./oom-revive'));
    ({ bumpSessionActivity } = await import('./message-store'));
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  it('grants one revive per user interaction', async () => {
    const { id } = await createTestSession({ status: 'running' });

    expect(await claimOomdRevive(id, 'killed')).toBe('revive');
    expect((await testPrisma.session.findUniqueOrThrow({ where: { id } })).restartNotice).toBe(
      'killed'
    );
    await testPrisma.session.update({ where: { id }, data: { restartNotice: null } });

    expect(await claimOomdRevive(id, 'killed again')).toBe('left_down');
    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id } })).restartNotice
    ).toBeNull();

    await new Promise((r) => setTimeout(r, 5));
    await bumpSessionActivity(id);
    expect(await claimOomdRevive(id, 'killed')).toBe('revive');
  });

  it('never revives a session that is no longer running', async () => {
    const { id } = await createTestSession({ status: 'stopped' });
    expect(await claimOomdRevive(id, 'killed')).toBe('not_running');
    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id } })).restartNotice
    ).toBeNull();
  });
});
