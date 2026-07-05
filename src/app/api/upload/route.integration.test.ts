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

function uploadRequest(body: FormData, token: string | null = TOKEN): Request {
  return new Request('http://localhost/api/upload', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  });
}

function formWith(sessionId: string | null, files: File[]): FormData {
  const form = new FormData();
  if (sessionId !== null) form.append('sessionId', sessionId);
  for (const file of files) form.append('files', file);
  return form;
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
    const res = await POST(uploadRequest(formWith(null, []), null));
    expect(res.status).toBe(401);
  });

  it('rejects an invalid sessionId', async () => {
    const res = await POST(uploadRequest(formWith('not-a-uuid', [new File(['x'], 'a.txt')])));
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-existent session', async () => {
    const missing = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const res = await POST(uploadRequest(formWith(missing, [new File(['x'], 'a.txt')])));
    expect(res.status).toBe(404);
  });

  it('rejects uploads to a non-running session', async () => {
    const sessionId = await createSession('stopped');
    const res = await POST(uploadRequest(formWith(sessionId, [new File(['x'], 'a.txt')])));
    expect(res.status).toBe(409);
  });

  it('rejects a request with no files', async () => {
    const sessionId = await createSession('running');
    const res = await POST(uploadRequest(formWith(sessionId, [])));
    expect(res.status).toBe(400);
  });

  it('rejects too many files', async () => {
    const sessionId = await createSession('running');
    const files = Array.from({ length: 21 }, (_, i) => new File(['x'], `f${i}.txt`));
    const res = await POST(uploadRequest(formWith(sessionId, files)));
    expect(res.status).toBe(413);
  });

  it('saves uploaded files and returns their attachments', async () => {
    const sessionId = await createSession('running');
    const form = formWith(sessionId, [
      new File(['hello'], 'notes.md'),
      new File(['world'], 'data.txt'),
    ]);

    const res = await POST(uploadRequest(form));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      attachments: { name: string; storedName: string; path: string }[];
    };
    expect(body.attachments).toHaveLength(2);
    expect(body.attachments.map((a) => a.name)).toEqual(['notes.md', 'data.txt']);

    // Files landed under the session workspace uploads dir and are readable.
    for (const att of body.attachments) {
      expect(att.path).toContain(getSessionWorkspacePath(sessionId));
    }
    expect(await readFile(body.attachments[0].path, 'utf8')).toBe('hello');
    expect(await readFile(body.attachments[1].path, 'utf8')).toBe('world');
  });
});
