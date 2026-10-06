import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { access, rm } from 'fs/promises';
import { randomUUID as uuid } from 'node:crypto';
import { setupTestDb, teardownTestDb, clearTestDb } from '@/test/setup-test-db';
import { createTestSession } from '@/test/fixtures';
import { sessionStatusSchema } from '@/lib/session-display-status';
import { createEmptyWorkspace, getSessionWorkspacePath } from './worktree-manager';

let removeArchivedWorkspaces: (typeof import('./session-lifecycle'))['removeArchivedWorkspaces'];

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

describe('removeArchivedWorkspaces', () => {
  const created: string[] = [];

  async function workspaceFor(sessionId: string): Promise<string> {
    created.push(sessionId);
    return createEmptyWorkspace(sessionId);
  }

  beforeAll(async () => {
    await setupTestDb();
    // After setupTestDb, so @/lib/prisma binds to the test database.
    ({ removeArchivedWorkspaces } = await import('./session-lifecycle'));
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await Promise.all(
      created.map((id) => rm(getSessionWorkspacePath(id), { recursive: true, force: true }))
    );
    await teardownTestDb();
  });

  it('removes archived sessions’ workspaces and keeps every other status’s', async () => {
    const archived = await createTestSession({ status: 'archived' });
    const archivedDir = await workspaceFor(archived.id);
    const keptDirs = await Promise.all(
      sessionStatusSchema.options
        .filter((status) => status !== 'archived')
        .map(async (status) => workspaceFor((await createTestSession({ status })).id))
    );

    await removeArchivedWorkspaces();

    expect(await exists(archivedDir)).toBe(false);
    for (const dir of keptDirs) expect(await exists(dir)).toBe(true);
  });

  it('keeps a workspace with no session row', async () => {
    const unknownDir = await workspaceFor(uuid());

    await removeArchivedWorkspaces();

    expect(await exists(unknownDir)).toBe(true);
  });
});
