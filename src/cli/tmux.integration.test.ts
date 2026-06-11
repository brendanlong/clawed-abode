import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createTmuxSession,
  listTmuxSessions,
  hasTmuxSession,
  killTmuxSession,
  killTmuxServer,
} from './tmux';

// Dedicated socket so tests never touch a real abode tmux server
const SOCKET = `abode-test-${process.pid}`;

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for condition');
}

afterAll(async () => {
  await killTmuxServer(SOCKET);
});

describe('tmux wrapper', () => {
  it('creates, lists, and kills sessions', async () => {
    await createTmuxSession({
      name: 'abode-test-session',
      cwd: tmpdir(),
      command: ['sleep', '30'],
      socket: SOCKET,
    });

    expect(await hasTmuxSession('abode-test-session', SOCKET)).toBe(true);
    expect(await listTmuxSessions(SOCKET)).toContain('abode-test-session');

    await killTmuxSession('abode-test-session', SOCKET);
    expect(await hasTmuxSession('abode-test-session', SOCKET)).toBe(false);
  });

  it('runs the command in the given cwd with the given env vars', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'abode-tmux-test-'));
    try {
      await createTmuxSession({
        name: 'abode-test-env',
        cwd: dir,
        env: { ABODE_TEST_VALUE: 'hello world; $special' },
        command: ['sh', '-c', 'printf %s\\\\n "$ABODE_TEST_VALUE" "$PWD" > result.txt'],
        socket: SOCKET,
      });

      let content = '';
      await waitFor(async () => {
        try {
          content = await readFile(join(dir, 'result.txt'), 'utf-8');
          return content.split('\n').length >= 2;
        } catch {
          return false;
        }
      });

      const [envValue, cwd] = content.split('\n');
      expect(envValue).toBe('hello world; $special');
      // Compare via realpath-insensitive suffix (macOS /private prefix, etc.)
      expect(cwd.endsWith(dir.split('/').slice(-1)[0])).toBe(true);
    } finally {
      await killTmuxSession('abode-test-env', SOCKET);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exact-matches session names instead of prefix matching', async () => {
    await createTmuxSession({
      name: 'abode-test-prefix-long',
      cwd: tmpdir(),
      command: ['sleep', '30'],
      socket: SOCKET,
    });

    expect(await hasTmuxSession('abode-test-prefix', SOCKET)).toBe(false);
    await killTmuxSession('abode-test-prefix', SOCKET);
    expect(await hasTmuxSession('abode-test-prefix-long', SOCKET)).toBe(true);

    await killTmuxSession('abode-test-prefix-long', SOCKET);
  });

  it('returns an empty set when the server is not running', async () => {
    expect(await listTmuxSessions(`abode-test-no-server-${process.pid}`)).toEqual(new Set());
  });
});
