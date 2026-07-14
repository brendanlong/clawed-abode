import { describe, it, expect } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, readFile, rm, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_BIN_ENV,
  SESSION_SCOPE_ENV,
  SESSION_SCOPE_LAUNCHER,
  sessionScopeUnitName,
} from '@/lib/session-scope';
import { getSessionScopeConfig, stopSessionScope, reapSessionScopes } from './session-cgroup';

const execFileAsync = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await delay(100);
  }
  return false;
}

async function readPid(path: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(path, 'utf8')).trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function waitForPid(path: string, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await readPid(path);
    if (pid !== null) return pid;
    await delay(100);
  }
  return null;
}

async function userScopeAvailable(): Promise<boolean> {
  try {
    await execFileAsync(
      'systemd-run',
      ['--user', '--scope', '--collect', '--quiet', '--', 'true'],
      {
        timeout: 5000,
      }
    );
    return true;
  } catch {
    return false;
  }
}

/** Write the launcher plus a fake "CLI" that double-forks a daemon then blocks. */
async function fixtures(dir: string, daemonPidFile: string, ranMarker: string) {
  const launcher = join(dir, 'launcher.sh');
  await writeFile(launcher, SESSION_SCOPE_LAUNCHER, { mode: 0o755 });
  await chmod(launcher, 0o755);

  const fakeCli = join(dir, 'fake-cli');
  await writeFile(
    fakeCli,
    `#!/bin/bash
: > '${ranMarker}'
setsid bash -c 'echo $$ > ${daemonPidFile}; exec sleep 300' </dev/null >/dev/null 2>&1 &
sleep 300 & wait
`,
    { mode: 0o755 }
  );
  await chmod(fakeCli, 0o755);
  return { launcher, fakeCli };
}

describe('session cgroup launcher + teardown (real processes)', () => {
  it('runs the CLI in a scope; stopSessionScope reaps the double-forked daemon', async (ctx) => {
    if (!(await userScopeAvailable())) ctx.skip('systemd user scope unavailable');
    const dir = await mkdtemp(join(tmpdir(), 'ca-sess-scope-'));
    const daemonPidFile = join(dir, 'daemon.pid');
    const ranMarker = join(dir, 'ran');
    const unit = sessionScopeUnitName('itest', 'a1b2c3d4');
    const { launcher, fakeCli } = await fixtures(dir, daemonPidFile, ranMarker);

    const proc = spawn('bash', [launcher], {
      stdio: 'ignore',
      env: { ...process.env, [SESSION_SCOPE_ENV]: unit, [CLAUDE_BIN_ENV]: fakeCli },
    });

    let daemonPid: number | null = null;
    try {
      daemonPid = await waitForPid(daemonPidFile, 8000);
      expect(daemonPid).not.toBeNull();
      expect(isAlive(daemonPid!)).toBe(true);

      // The daemon must be inside our scope's cgroup.
      const cgroup = await readFile(`/proc/${daemonPid}/cgroup`, 'utf8');
      expect(cgroup).toContain(unit);

      await stopSessionScope(unit);

      // A cgroup stop reaps the daemonized grandchild despite the double-fork.
      expect(await waitFor(() => !isAlive(daemonPid!), 10000)).toBe(true);
    } finally {
      if (daemonPid && isAlive(daemonPid)) process.kill(daemonPid, 'SIGKILL');
      proc.kill('SIGKILL');
      await stopSessionScope(unit);
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('reapSessionScopes reaps only the named scope, leaving others alive', async (ctx) => {
    if (!(await userScopeAvailable())) ctx.skip('systemd user scope unavailable');
    // Two scoped sessions running concurrently: one is the crash orphan we reap
    // by exact name, the other stands in for a co-tenant's live session that the
    // reap must NOT touch (the bug the old broad glob caused).
    const dirA = await mkdtemp(join(tmpdir(), 'ca-sess-reapA-'));
    const dirB = await mkdtemp(join(tmpdir(), 'ca-sess-reapB-'));
    const pidA = join(dirA, 'daemon.pid');
    const pidB = join(dirB, 'daemon.pid');
    const unitA = sessionScopeUnitName('reap', 'aaaa0000');
    const unitB = sessionScopeUnitName('reap', 'bbbb0000');
    const fixA = await fixtures(dirA, pidA, join(dirA, 'ran'));
    const fixB = await fixtures(dirB, pidB, join(dirB, 'ran'));

    const procA = spawn('bash', [fixA.launcher], {
      stdio: 'ignore',
      env: { ...process.env, [SESSION_SCOPE_ENV]: unitA, [CLAUDE_BIN_ENV]: fixA.fakeCli },
    });
    const procB = spawn('bash', [fixB.launcher], {
      stdio: 'ignore',
      env: { ...process.env, [SESSION_SCOPE_ENV]: unitB, [CLAUDE_BIN_ENV]: fixB.fakeCli },
    });
    let daemonA: number | null = null;
    let daemonB: number | null = null;
    try {
      daemonA = await waitForPid(pidA, 8000);
      daemonB = await waitForPid(pidB, 8000);
      expect(daemonA).not.toBeNull();
      expect(daemonB).not.toBeNull();

      // Reap ONLY scope A by exact name.
      await reapSessionScopes([unitA]);

      expect(await waitFor(() => !isAlive(daemonA!), 10000)).toBe(true);
      // B was never named, so it (and its daemon) survives.
      expect(isAlive(daemonB!)).toBe(true);
    } finally {
      for (const pid of [daemonA, daemonB]) if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
      procA.kill('SIGKILL');
      procB.kill('SIGKILL');
      await stopSessionScope(unitA);
      await stopSessionScope(unitB);
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  }, 30000);

  it('falls back to running the CLI unwrapped when no scope env is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-sess-fallback-'));
    const ranMarker = join(dir, 'ran');
    const launcher = join(dir, 'launcher.sh');
    await writeFile(launcher, SESSION_SCOPE_LAUNCHER, { mode: 0o755 });
    await chmod(launcher, 0o755);
    const fakeCli = join(dir, 'fake-cli');
    await writeFile(fakeCli, `#!/bin/bash\n: > '${ranMarker}'\n`, { mode: 0o755 });
    await chmod(fakeCli, 0o755);

    try {
      // No SESSION_SCOPE_ENV → launcher execs the CLI directly.
      await execFileAsync('bash', [launcher], {
        env: { ...process.env, [CLAUDE_BIN_ENV]: fakeCli, [SESSION_SCOPE_ENV]: '' },
        timeout: 10000,
      });
      await expect(access(ranMarker)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);
});

describe('getSessionScopeConfig', () => {
  it('resolves an existing, executable Claude binary and writes the launcher', async () => {
    // Independent of systemd: the launcher self-probes at runtime, so the config
    // is available whenever the CLI binary resolves (it's installed here + on CI).
    const config = await getSessionScopeConfig();
    expect(config).not.toBeNull();
    await expect(access(config!.claudeBin, fsConstants.X_OK)).resolves.toBeUndefined();
    await expect(access(config!.launcherPath, fsConstants.X_OK)).resolves.toBeUndefined();
  }, 20000);
});
