import { describe, it, expect } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

/**
 * Whether this host has the unprivileged systemd user scope the reaper relies on.
 * The deployment host always does; CI runners generally don't, so the reaping
 * tests below skip there rather than fail.
 */
async function cgroupSupported(): Promise<boolean> {
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

describe('background command reaper (real processes)', () => {
  it('SIGTERM reaps a daemonized double-forked grandchild via the cgroup', async () => {
    if (!(await cgroupSupported())) {
      console.warn('skipping cgroup reaper test: systemd user scope unavailable');
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), 'ca-reaper-cg-'));
    const daemonPidFile = join(dir, 'daemon.pid');
    const readyFile = join(dir, 'ready');

    // Double-fork a daemon that detaches into its own session (the Postgres
    // `pg_ctl start` pattern) — a plain process-group kill could not reach it.
    const command = [
      `setsid bash -c 'echo $$ > ${daemonPidFile}; exec sleep 300' </dev/null >/dev/null 2>&1 &`,
      `: > ${readyFile}`,
      'sleep 300 & wait',
    ].join('\n');

    const wrapped = wrapBackgroundCommand(command);
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

/** Run a wrapped command to natural completion, capturing stdout + exit code. */
function runToCompletion(wrapped: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', wrapped], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout }));
  });
}

describe('wrapper stdout / exit-code preservation', () => {
  it('passes the command stdout and exit code through the scope unchanged', async () => {
    if (!(await cgroupSupported())) {
      console.warn('skipping preservation test: systemd user scope unavailable');
      return;
    }
    const wrapped = wrapBackgroundCommand('echo hello-from-cmd; exit 37');
    const { code, stdout } = await runToCompletion(wrapped);
    expect(stdout.trim()).toBe('hello-from-cmd');
    expect(code).toBe(37);
  }, 20000);
});
