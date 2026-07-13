import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, toError } from '@/lib/logger';
import { SESSION_SCOPE_LAUNCHER, SESSION_SCOPE_UNIT_GLOB } from '@/lib/session-scope';

const execFileAsync = promisify(execFile);
const log = createLogger('session-cgroup');

/** Resolved config needed to launch a session inside a systemd user scope. */
export interface SessionScopeConfig {
  /** Path to the launcher script (set as SDK `pathToClaudeCodeExecutable`). */
  launcherPath: string;
  /** Absolute path to the real Claude CLI binary the launcher execs. */
  claudeBin: string;
}

/**
 * Resolve the native Claude CLI binary the SDK would spawn by default, from the
 * SDK's own module context (the platform package is an optionalDependency of the
 * SDK, not hoisted to the app's node_modules). Mirrors the SDK's own selection:
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]`. Returns null if it
 * can't be resolved (e.g. an unexpected platform) so the caller runs unwrapped.
 */
function resolveClaudeBinary(): string | null {
  try {
    // Anchor resolution at the app root (where node_modules lives), not
    // import.meta.url — in a bundled/Turbopack prod build the module may live
    // under .next/, from which the SDK package might not resolve.
    const req = createRequire(join(process.cwd(), 'package.json'));
    const sdkReq = createRequire(req.resolve('@anthropic-ai/claude-agent-sdk'));
    let libc = '';
    try {
      // glibcVersionRuntime is present on glibc, absent on musl.
      const report = process.report?.getReport() as
        | { header?: { glibcVersionRuntime?: string } }
        | undefined;
      if (report && !report.header?.glibcVersionRuntime) libc = '-musl';
    } catch {
      // Assume glibc if the report is unavailable.
    }
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libc}`;
    return sdkReq.resolve(`${pkg}/claude`);
  } catch (err) {
    log.warn('Could not resolve the Claude CLI binary; sessions run without a cgroup scope', {
      error: toError(err).message,
    });
    return null;
  }
}

/**
 * Whether an unprivileged systemd user scope can actually be created here — using
 * the SAME flags the launcher will (`--unit` + `TimeoutStopSec`), so a host that
 * passes the probe will also succeed at the real launch (the launcher can't fall
 * back after `exec`ing systemd-run). The probe unit is `--collect`ed away.
 */
async function probeUserScope(): Promise<boolean> {
  try {
    await execFileAsync(
      'systemd-run',
      [
        '--user',
        '--scope',
        '--collect',
        '--quiet',
        '-p',
        'TimeoutStopSec=10',
        `--unit=clawed-probe-${process.pid}.scope`,
        '--',
        'true',
      ],
      { timeout: 5000 }
    );
    return true;
  } catch (err) {
    log.info('systemd user scope unavailable; sessions run without a cgroup scope', {
      error: toError(err).message,
    });
    return false;
  }
}

/**
 * Write the launcher script to a stable temp path and return it. A fixed name (no
 * pid) means at most one such file exists — re-runs overwrite identical bytes —
 * so it doesn't accumulate across restarts.
 */
async function writeLauncher(): Promise<string> {
  const path = join(tmpdir(), 'clawed-session-launcher.sh');
  await writeFile(path, SESSION_SCOPE_LAUNCHER, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

let scopeConfigPromise: Promise<SessionScopeConfig | null> | null = null;

/**
 * The session-scope launch config for this host, probed once and memoized
 * (capabilities don't change over the process lifetime). Resolves to null when
 * systemd user scopes or the CLI binary aren't available — the caller then
 * launches the session normally (unwrapped, no reaping).
 */
export async function getSessionScopeConfig(): Promise<SessionScopeConfig | null> {
  if (!scopeConfigPromise) {
    scopeConfigPromise = (async () => {
      const [supported, claudeBin] = await Promise.all([probeUserScope(), resolveClaudeBinary()]);
      if (!supported || !claudeBin) return null;
      try {
        const launcherPath = await writeLauncher();
        log.info('Session cgroup reaping enabled', { launcherPath, claudeBin });
        return { launcherPath, claudeBin };
      } catch (err) {
        log.warn('Could not write the session-scope launcher; sessions run unwrapped', {
          error: toError(err).message,
        });
        return null;
      }
    })();
  }
  return scopeConfigPromise;
}

/** A short random suffix distinguishing scope units across establishments. */
export function sessionScopeNonce(): string {
  return randomBytes(4).toString('hex');
}

/**
 * Stop a session's systemd scope, cgroup-killing its whole process tree (incl.
 * daemonized double-forks). Best-effort and idempotent: a missing/already-stopped
 * unit is fine. Called on session teardown (stop / delete / shutdown).
 */
export async function stopSessionScope(unitName: string): Promise<void> {
  try {
    await execFileAsync('systemctl', ['--user', 'stop', unitName], { timeout: 15000 });
  } catch (err) {
    // Non-zero when the unit is already gone — expected, not an error worth surfacing.
    log.debug('stopSessionScope: stop returned non-zero (unit likely already gone)', {
      unitName,
      error: toError(err).message,
    });
  }
  try {
    await execFileAsync('systemctl', ['--user', 'reset-failed', unitName], { timeout: 5000 });
  } catch {
    // reset-failed is cleanup only.
  }
}

/**
 * Stop every session scope. Run once at startup to reap scopes orphaned by a
 * previous server crash (which never ran teardown) before sessions revive into
 * fresh scopes. Best-effort.
 */
export async function sweepSessionScopes(): Promise<void> {
  try {
    await execFileAsync('systemctl', ['--user', 'stop', SESSION_SCOPE_UNIT_GLOB], {
      timeout: 15000,
    });
    log.info('Swept orphaned session scopes on startup');
  } catch (err) {
    // Non-zero when no units match — the common, healthy case.
    log.debug('sweepSessionScopes: nothing to sweep or systemd unavailable', {
      error: toError(err).message,
    });
  }
}
