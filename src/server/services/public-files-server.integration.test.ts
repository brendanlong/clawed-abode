import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdir, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

// The server imports @/lib/prisma at module load, so import it only after the test DB is configured.
let getSessionPublicDir: typeof import('./public-dir').getSessionPublicDir;
let getSessionWorkspacePath: typeof import('./worktree-manager').getSessionWorkspacePath;
let server: Server;
let baseUrl: string;

const TOKEN = 'public-route-test-token';
const createdSessionIds: string[] = [];

async function createSession(status = 'running'): Promise<string> {
  const session = await testPrisma.session.create({ data: { name: 'test', status } });
  createdSessionIds.push(session.id);
  await mkdir(getSessionPublicDir(session.id), { recursive: true });
  return session.id;
}

async function writePublic(sessionId: string, relPath: string, content: string): Promise<void> {
  const file = path.join(getSessionPublicDir(sessionId), relPath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

function get(
  pathname: string,
  token: string | null = TOKEN,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    redirect: 'manual',
    headers: { ...headers, ...(token ? { cookie: `other=1; public_auth=${token}` } : {}) },
  });
}

beforeAll(async () => {
  await setupTestDb();
  ({ getSessionPublicDir } = await import('./public-dir'));
  ({ getSessionWorkspacePath } = await import('./worktree-manager'));
  const { createPublicFilesServer } = await import('./public-files-server');
  server = createPublicFilesServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await testPrisma.authSession.create({
    data: { token: TOKEN, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
});

afterEach(async () => {
  await Promise.all(
    createdSessionIds.map((id) => rm(getSessionWorkspacePath(id), { recursive: true, force: true }))
  );
  createdSessionIds.length = 0;
  await testPrisma.session.deleteMany();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await clearTestDb();
  await teardownTestDb();
});

describe('public files server', () => {
  it('requires a valid auth cookie', async () => {
    const id = await createSession();
    await writePublic(id, 'a.txt', 'secret');

    expect((await get(`/${id}/a.txt`, null)).status).toBe(401);
    expect((await get(`/${id}/a.txt`, 'bogus')).status).toBe(401);
  });

  it('rejects non-read methods', async () => {
    const id = await createSession();
    const res = await fetch(`${baseUrl}/${id}/`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('answers HEAD without a body', async () => {
    const id = await createSession();
    await writePublic(id, 'a.txt', 'hello');

    const res = await fetch(`${baseUrl}/${id}/a.txt`, {
      method: 'HEAD',
      headers: { cookie: `public_auth=${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('5');
    expect(await res.text()).toBe('');
  });

  it('serves a file with an extension-derived content type and no-cache', async () => {
    const id = await createSession();
    await writePublic(id, 'plots/chart.svg', '<svg/>');

    const res = await get(`/${id}/plots/chart.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe('<svg/>');
  });

  it('serves byte ranges', async () => {
    const id = await createSession();
    await writePublic(id, 'clip.mp4', '0123456789');

    const res = await get(`/${id}/clip.mp4`, TOKEN, { range: 'bytes=2-4' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(res.headers.get('content-length')).toBe('3');
    expect(await res.text()).toBe('234');

    const past = await get(`/${id}/clip.mp4`, TOKEN, { range: 'bytes=10-' });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe('bytes */10');
  });

  it('serves empty files', async () => {
    const id = await createSession();
    await writePublic(id, 'empty.txt', '');

    const res = await get(`/${id}/empty.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('decodes percent-encoded names', async () => {
    const id = await createSession();
    await writePublic(id, 'my report.html', 'hi');

    const res = await get(`/${id}/my%20report.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('redirects a directory without a trailing slash so relative links resolve', async () => {
    const id = await createSession();
    await writePublic(id, 'docs/index.html', 'index');

    const res = await get(`/${id}/docs`);
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`/${id}/docs/`);
    expect((await get(`/${id}`)).headers.get('location')).toBe(`/${id}/`);
  });

  it('serves index.html for a directory that has one', async () => {
    const id = await createSession();
    await writePublic(id, 'index.html', '<h1>home</h1>');

    const res = await get(`/${id}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('<h1>home</h1>');
  });

  it('lists a directory without index.html', async () => {
    const id = await createSession();
    await writePublic(id, 'a.png', 'x');
    await writePublic(id, 'sub/b.png', 'y');

    const res = await get(`/${id}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="a.png"');
    expect(html).toContain('href="sub/"');
  });

  it('404s for missing files, a missing public dir, and malformed session ids', async () => {
    const id = await createSession();
    expect((await get(`/${id}/nope.html`)).status).toBe(404);

    await rm(getSessionPublicDir(id), { recursive: true });
    expect((await get(`/${id}/`)).status).toBe(404);

    expect((await get('/not-a-uuid/')).status).toBe(404);
    expect((await get(`/${randomUUID()}/`)).status).toBe(404);
  });

  it('does not serve archived sessions even if files remain', async () => {
    const id = await createSession('archived');
    await writePublic(id, 'a.txt', 'x');

    expect((await get(`/${id}/a.txt`)).status).toBe(404);
  });

  it('refuses traversal and symlinks that escape the public dir', async () => {
    const id = await createSession();
    await writeFile(path.join(getSessionWorkspacePath(id), 'secret.txt'), 'secret');
    await symlink(os.homedir(), path.join(getSessionPublicDir(id), 'home'));
    await symlink('../secret.txt', path.join(getSessionPublicDir(id), 'leak.txt'));

    expect((await get(`/${id}/..%2Fsecret.txt`)).status).toBe(404);
    expect((await get(`/${id}/%2E%2E/secret.txt`)).status).toBe(404);
    expect((await get(`/${id}/leak.txt`)).status).toBe(404);
    expect((await get(`/${id}/home/`)).status).toBe(404);
  });

  it('follows symlinks that stay inside the public dir', async () => {
    const id = await createSession();
    await writePublic(id, 'real.txt', 'real');
    await symlink('real.txt', path.join(getSessionPublicDir(id), 'alias.txt'));

    const res = await get(`/${id}/alias.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('real');
  });
});
