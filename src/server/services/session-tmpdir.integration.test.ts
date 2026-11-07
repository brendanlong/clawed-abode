import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { ensureSessionTmpDir, getSessionTmpDir } from './session-tmpdir';
import { removeWorkspace } from './worktree-manager';

let fakeTmp: string;
let originalTmpdir: string | undefined;

beforeEach(async () => {
  fakeTmp = await mkdtemp(path.join(tmpdir(), 'session-tmpdir-test-'));
  originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = fakeTmp;
});

afterEach(async () => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await rm(fakeTmp, { recursive: true, force: true });
});

describe('ensureSessionTmpDir', () => {
  it('creates a private per-session dir under the temp root, keeping files across repeat calls', async () => {
    const dir = await ensureSessionTmpDir('s1');
    expect(dir.startsWith(fakeTmp)).toBe(true);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);

    await writeFile(path.join(dir, 'keep'), 'x');
    expect(await ensureSessionTmpDir('s1')).toBe(dir);
    await expect(stat(path.join(dir, 'keep'))).resolves.toBeTruthy();
    expect(await ensureSessionTmpDir('s2')).not.toBe(dir);
  });

  it('makes a shared root we own private again if its mode was loosened', async () => {
    const root = path.dirname(getSessionTmpDir('s1'));
    await mkdir(root);
    await chmod(root, 0o777);
    await ensureSessionTmpDir('s1');
    expect((await stat(root)).mode & 0o777).toBe(0o700);
  });

  it('refuses a shared root that is a symlink', async () => {
    const target = path.join(fakeTmp, 'elsewhere');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, path.dirname(getSessionTmpDir('s1')));
    await expect(ensureSessionTmpDir('s1')).rejects.toThrow();
  });
});

describe('removeWorkspace', () => {
  it("removes the session's temp dir along with its workspace", async () => {
    const sessionId = `session-tmpdir-test-${randomUUID()}`;
    const dir = await ensureSessionTmpDir(sessionId);
    await writeFile(path.join(dir, 'leftover'), 'x');
    await removeWorkspace(sessionId);
    await expect(stat(dir)).rejects.toThrow();
  });
});
