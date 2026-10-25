import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { link, lstat, mkdir, readdir, rm, symlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestDb, teardownTestDb, clearTestDb } from '@/test/setup-test-db';
import { createTestSession } from '@/test/fixtures';

const root = await vi.hoisted(async () => {
  const { mkdtemp } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  return mkdtemp(join(tmpdir(), 'disk-usage-test-'));
});
vi.mock('./worktree-manager', () => ({
  WORKTREES_DIR: root,
  getSessionWorkspacePath: (sessionId: string) => join(root, sessionId),
}));
vi.mock('@/lib/logger', async () => (await import('@/test/mock-logger')).mockLoggerModule());

let diskUsage: typeof import('./disk-usage');

async function allocatedBytes(path: string): Promise<number> {
  const stats = await lstat(path);
  return stats.blocks * 512;
}

async function sumAllocated(dir: string): Promise<number> {
  let total = await allocatedBytes(dir);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await sumAllocated(path) : await allocatedBytes(path);
  }
  return total;
}

const payload = (kb: number) => Buffer.alloc(kb * 1024, 1);

describe('disk usage', () => {
  beforeAll(async () => {
    await setupTestDb();
    diskUsage = await import('./disk-usage');
  });

  afterAll(async () => {
    await teardownTestDb();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(clearTestDb);

  describe('measureOwnedBytes', () => {
    it('leaves out files hardlinked from outside the tree and counts internal hardlinks once', async () => {
      const cache = join(root, 'cache');
      const tree = join(root, 'tree');
      await mkdir(cache);
      await mkdir(join(tree, 'nested'), { recursive: true });
      await writeFile(join(cache, 'shared'), payload(64));
      await link(join(cache, 'shared'), join(tree, 'from-cache'));
      await writeFile(join(tree, 'own'), payload(16));
      await writeFile(join(tree, 'nested', 'a'), payload(32));
      await link(join(tree, 'nested', 'a'), join(tree, 'b'));
      await symlink(join(cache, 'shared'), join(tree, 'symlink'));

      const expected =
        (await sumAllocated(tree)) -
        (await allocatedBytes(join(tree, 'from-cache'))) -
        (await allocatedBytes(join(tree, 'b')));

      expect(await diskUsage.measureOwnedBytes(tree)).toBe(expected);
      expect(expected).toBeGreaterThanOrEqual((16 + 32) * 1024);
    });

    it('measures a missing directory as empty', async () => {
      expect(await diskUsage.measureOwnedBytes(join(root, 'does-not-exist'))).toBe(0);
    });
  });

  describe('getWorkspaceDiskUsage', () => {
    it('lists sessions with a workspace, largest first', async () => {
      const small = await createTestSession({ name: 'small' });
      const large = await createTestSession({ name: 'large' });
      const archived = await createTestSession({ name: 'archived', status: 'archived' });
      await createTestSession({ name: 'failed setup', status: 'error' });
      for (const [session, kb] of [
        [small, 8],
        [large, 128],
        [archived, 256],
      ] as const) {
        await mkdir(join(root, session.id));
        await writeFile(join(root, session.id, 'file'), payload(kb));
      }

      const result = await diskUsage.getWorkspaceDiskUsage();

      expect(result.sessions.map((s) => s.name)).toEqual(['large', 'small']);
      expect(result.sessions[0].bytes).toBeGreaterThanOrEqual(128 * 1024);
      expect(result.filesystem.totalBytes).toBeGreaterThan(result.filesystem.freeBytes);
    });
  });
});
