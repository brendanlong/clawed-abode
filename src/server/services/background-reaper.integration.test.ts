import { describe, it, expect } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapBackgroundCommand } from '@/lib/background-command';

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

/** Poll `fn` until it returns true or the deadline passes. */
async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await delay(100);
  }
  return false;
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

async function readPid(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Poll until the pid file has a valid pid (the writer may create then fill it). */
async function waitForPid(path: string, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await readPid(path);
    if (pid !== null) return pid;
    await delay(100);
  }
  return null;
}

/** Whether this host supports the unprivileged systemd user scope (cgroup mode). */
async function cgroupSupported(): Promise<boolean> {
  try {
    await execFileAsync(
      'systemd-run',
      ['--user', '--scope', '--collect', '--quiet', '--', 'true'],
      { timeout: 5000 }
    );
    return true;
  } catch {
    return false;
  }
}

describe('background command reaper (real processes)', () => {
  it('process-group mode: SIGTERM runs the command trap and kills the whole group', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-reaper-pg-'));
    const trapFile = join(dir, 'trap');
    const childPidFile = join(dir, 'child.pid');
    const readyFile = join(dir, 'ready');

    // A command with its own cleanup trap plus a long-lived in-group child.
    const command = [
      `trap 'echo done > ${trapFile}; exit 0' TERM INT`,
      `sleep 300 & echo $! > ${childPidFile}`,
      `: > ${readyFile}`,
      'wait',
    ].join('\n');

    const wrapped = wrapBackgroundCommand(command, 'process-group');
    const proc = spawn('bash', ['-c', wrapped], { stdio: 'ignore' });

    let childPid: number | null = null;
    try {
      expect(await waitFor(() => fileExists(readyFile), 5000)).toBe(true);
      childPid = await waitForPid(childPidFile, 5000);
      expect(childPid).not.toBeNull();
      expect(isAlive(childPid!)).toBe(true);

      proc.kill('SIGTERM');

      // The command's own trap must run (proves the group got SIGTERM, not just
      // the supervisor), and the in-group child must die.
      expect(await waitFor(() => fileExists(trapFile), 8000)).toBe(true);
      expect((await readFile(trapFile, 'utf8')).trim()).toBe('done');
      expect(await waitFor(() => !isAlive(childPid!), 8000)).toBe(true);
    } finally {
      if (childPid && isAlive(childPid)) process.kill(childPid, 'SIGKILL');
      proc.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('cgroup mode: SIGTERM reaps a daemonized double-forked grandchild', async () => {
    if (!(await cgroupSupported())) {
      // Best-effort feature; on hosts without a systemd user scope the app falls
      // back to process-group mode (covered above).
      console.warn('skipping cgroup reaper test: systemd user scope unavailable');
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), 'ca-reaper-cg-'));
    const daemonPidFile = join(dir, 'daemon.pid');
    const readyFile = join(dir, 'ready');

    // Double-fork a daemon that detaches into its own session (the Postgres
    // `pg_ctl start` pattern) — a process-group kill could not reach it.
    const command = [
      `setsid bash -c 'echo $$ > ${daemonPidFile}; exec sleep 300' </dev/null >/dev/null 2>&1 &`,
      `: > ${readyFile}`,
      'sleep 300 & wait',
    ].join('\n');

    const wrapped = wrapBackgroundCommand(command, 'cgroup');
    const proc = spawn('bash', ['-c', wrapped], { stdio: 'ignore' });

    let daemonPid: number | null = null;
    try {
      daemonPid = await waitForPid(daemonPidFile, 8000);
      expect(daemonPid).not.toBeNull();
      expect(isAlive(daemonPid!)).toBe(true);

      proc.kill('SIGTERM');

      // The cgroup kill reaps the daemonized grandchild despite the double-fork.
      expect(await waitFor(() => !isAlive(daemonPid!), 10000)).toBe(true);
    } finally {
      if (daemonPid && isAlive(daemonPid)) process.kill(daemonPid, 'SIGKILL');
      proc.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
