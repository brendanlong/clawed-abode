import { describe, it, expect } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_BIN_ENV,
  SESSION_SCOPE_ENV,
  SESSION_SCOPE_LAUNCHER,
  sessionScopeUnitName,
} from '@/lib/session-scope';
import { getSessionScopeConfig, stopSessionScope, sweepSessionScopes } from './session-cgroup';

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

  it('sweepSessionScopes reaps a leftover session scope', async (ctx) => {
    if (!(await userScopeAvailable())) ctx.skip('systemd user scope unavailable');
    const dir = await mkdtemp(join(tmpdir(), 'ca-sess-sweep-'));
    const daemonPidFile = join(dir, 'daemon.pid');
    const ranMarker = join(dir, 'ran');
    const unit = sessionScopeUnitName('sweep', 'feed0000');
    const { launcher, fakeCli } = await fixtures(dir, daemonPidFile, ranMarker);

    // Launch a scoped session (an orphan a crashed server would leave behind).
    const proc = spawn('bash', [launcher], {
      stdio: 'ignore',
      env: { ...process.env, [SESSION_SCOPE_ENV]: unit, [CLAUDE_BIN_ENV]: fakeCli },
    });
    let daemonPid: number | null = null;
    try {
      daemonPid = await waitForPid(daemonPidFile, 8000);
      expect(daemonPid).not.toBeNull();

      await sweepSessionScopes();

      expect(await waitFor(() => !isAlive(daemonPid!), 10000)).toBe(true);
    } finally {
      if (daemonPid && isAlive(daemonPid)) process.kill(daemonPid, 'SIGKILL');
      proc.kill('SIGKILL');
      await stopSessionScope(unit);
      await rm(dir, { recursive: true, force: true });
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
  it('resolves an existing, executable Claude binary and launcher when supported', async () => {
    const config = await getSessionScopeConfig();
    if (!(await userScopeAvailable())) {
      // On a host without a user scope the config is null (sessions run unwrapped).
      expect(config).toBeNull();
      return;
    }
    expect(config).not.toBeNull();
    await expect(access(config!.claudeBin)).resolves.toBeUndefined();
    await expect(access(config!.launcherPath)).resolves.toBeUndefined();
  }, 20000);
});
