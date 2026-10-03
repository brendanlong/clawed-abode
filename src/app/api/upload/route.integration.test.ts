import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { rm, readFile } from 'fs/promises';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

// The route imports @/lib/prisma at module load, so import it (and worktree-manager
// for workspace cleanup) only after the test DB is configured.
let POST: typeof import('./route').POST;
let getSessionWorkspacePath: typeof import('@/server/services/worktree-manager').getSessionWorkspacePath;

const TOKEN = 'upload-route-test-token';
const createdSessionIds: string[] = [];

async function createSession(status: string): Promise<string> {
  const session = await testPrisma.session.create({
    data: { name: 'test', status },
  });
  createdSessionIds.push(session.id);
  return session.id;
}

function uploadRequest(
  query: Record<string, string>,
  body: string | null,
  token: string | null = TOKEN
): Request {
  return new Request(`http://localhost/api/upload?${new URLSearchParams(query)}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  });
}

beforeAll(async () => {
  await setupTestDb();
  ({ POST } = await import('./route'));
  ({ getSessionWorkspacePath } = await import('@/server/services/worktree-manager'));

  await testPrisma.authSession.create({
    data: { token: TOKEN, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
});

afterEach(async () => {
  await Promise.all(
    createdSessionIds.map((id) => rm(getSessionWorkspacePath(id), { recursive: true, force: true }))
  );
  createdSessionIds.length = 0;
  // Keep the auth session; only clear sessions/messages between tests.
  await testPrisma.message.deleteMany();
  await testPrisma.session.deleteMany();
});

afterAll(async () => {
  await clearTestDb();
  await teardownTestDb();
});

describe('POST /api/upload', () => {
  it('rejects unauthenticated requests', async () => {
    const sessionId = await createSession('running');
    const res = await POST(uploadRequest({ sessionId, name: 'a.txt' }, 'x', null));
    expect(res.status).toBe(401);
  });

  it('rejects an invalid sessionId', async () => {
    const res = await POST(uploadRequest({ sessionId: 'not-a-uuid', name: 'a.txt' }, 'x'));
    expect(res.status).toBe(400);
  });

  it('rejects a missing name', async () => {
    const sessionId = await createSession('running');
    const res = await POST(uploadRequest({ sessionId }, 'x'));
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-existent session', async () => {
    const missing = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const res = await POST(uploadRequest({ sessionId: missing, name: 'a.txt' }, 'x'));
    expect(res.status).toBe(404);
  });

  it('rejects uploads to a non-running session', async () => {
    const sessionId = await createSession('stopped');
    const res = await POST(uploadRequest({ sessionId, name: 'a.txt' }, 'x'));
    expect(res.status).toBe(409);
  });

  it('saves the raw body and returns the attachment', async () => {
    const sessionId = await createSession('running');
    const res = await POST(uploadRequest({ sessionId, name: 'notes.md' }, 'hello'));
    expect(res.status).toBe(200);

    const { attachment } = (await res.json()) as {
      attachment: { name: string; storedName: string; path: string };
    };
    expect(attachment.name).toBe('notes.md');
    expect(attachment.path).toContain(getSessionWorkspacePath(sessionId));
    expect(await readFile(attachment.path, 'utf8')).toBe('hello');
  });

  it('saves an empty file', async () => {
    const sessionId = await createSession('running');
    const res = await POST(uploadRequest({ sessionId, name: 'empty.txt' }, null));
    expect(res.status).toBe(200);

    const { attachment } = (await res.json()) as { attachment: { path: string } };
    expect(await readFile(attachment.path, 'utf8')).toBe('');
  });
});
