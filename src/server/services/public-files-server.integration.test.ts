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
let mintPublicLoginCode: typeof import('./public-login-codes').mintPublicLoginCode;
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
  ({ mintPublicLoginCode } = await import('./public-login-codes'));
  const { createPublicFilesServer } = await import('./public-files-server');
  server = createPublicFilesServer({ baseUrl: 'https://h.ts.net:8444' });
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

    const res = await get(`/${id}/a.txt?v=1`, null);
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain(
      `href="https://h.ts.net/login?public=${encodeURIComponent(`/${id}/a.txt?v=1`)}"`
    );
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

  it('refuses a public dir that is itself a symlink', async () => {
    const id = await createSession();
    const elsewhere = path.join(getSessionWorkspacePath(id), 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, 'secret.txt'), 'secret');
    await rm(getSessionPublicDir(id), { recursive: true });
    await symlink(elsewhere, getSessionPublicDir(id));

    expect((await get(`/${id}/secret.txt`)).status).toBe(404);
    expect((await get(`/${id}/`)).status).toBe(404);
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

describe('public files login', () => {
  function cookieToken(res: Response): string | null {
    return res.headers.get('set-cookie')?.match(/^public_auth=([^;]+)/)?.[1] ?? null;
  }

  it('exchanges a one-time code for a new auth session and redirects to next', async () => {
    const id = await createSession();
    const next = `/${id}/a.html?x=1`;

    const res = await get(
      `/_login?code=${mintPublicLoginCode()}&next=${encodeURIComponent(next)}`,
      null,
      { 'user-agent': 'custom-tab', 'x-forwarded-for': '100.64.0.9' }
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(next);
    const token = cookieToken(res);
    expect(token).not.toBeNull();
    expect(token).not.toBe(TOKEN);
    const row = await testPrisma.authSession.findUnique({ where: { token: token! } });
    expect(row).toMatchObject({ userAgent: 'custom-tab', ipAddress: '100.64.0.9' });

    await writePublic(id, 'a.html', 'hi');
    expect((await get(next, token)).status).toBe(200);
  });

  it('accepts a code only once', async () => {
    const code = mintPublicLoginCode();
    await get(`/_login?code=${code}&next=/`, null);

    const res = await get(`/_login?code=${code}&next=/`, null);
    expect(res.status).toBe(200);
    expect(cookieToken(res)).toBeNull();
    expect(await res.text()).toContain('That link has expired');
  });

  it('does not spend the code on HEAD', async () => {
    const code = mintPublicLoginCode();
    const head = await fetch(`${baseUrl}/_login?code=${code}&next=/`, {
      method: 'HEAD',
      redirect: 'manual',
    });
    expect(cookieToken(head)).toBeNull();

    expect(cookieToken(await get(`/_login?code=${code}&next=/`, null))).not.toBeNull();
  });

  it('does not open another auth session for a browser that is already signed in, but spends the code', async () => {
    const before = await testPrisma.authSession.count();

    const code = mintPublicLoginCode();
    const res = await get(`/_login?code=${code}&next=/x`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/x');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await testPrisma.authSession.count()).toBe(before);

    // Still spent, so it can't be replayed from this browser's history.
    expect(cookieToken(await get(`/_login?code=${code}&next=/x`, null))).toBeNull();
  });

  it('never redirects off-origin', async () => {
    for (const next of ['//evil.example/', '/%09/evil.example/', '/%5Cevil.example/']) {
      const res = await get(`/_login?next=${next}`);
      expect(res.headers.get('location')).toBe('/');
    }
    const crlf = await get('/_login?next=/a%0D%0ASet-Cookie:%20x=1');
    expect(crlf.status).toBe(303);
    expect(crlf.headers.get('set-cookie')).toBeNull();
  });

  it('only accepts GET and HEAD', async () => {
    const res = await fetch(`${baseUrl}/_login`, { method: 'POST', body: 'password=x' });
    expect(res.status).toBe(405);
  });
});
