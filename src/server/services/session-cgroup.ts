import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { writeFile, chmod, mkdir, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger, toError } from '@/lib/logger';
import { SESSION_SCOPE_LAUNCHER, SESSION_SCOPE_UNIT_GLOB } from '@/lib/session-scope';

const execFileAsync = promisify(execFile);
const log = createLogger('session-cgroup');

/** App-owned launcher location (not world-writable /tmp, not tmp-reaped). */
const LAUNCHER_DIR = join(homedir(), '.clawed');
const LAUNCHER_PATH = join(LAUNCHER_DIR, 'session-launcher.sh');

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
 * can't be resolved or isn't executable — the caller then launches the CLI the
 * SDK's own way (no scope), so a bad guess never breaks sessions.
 */
async function resolveClaudeBinary(): Promise<string | null> {
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
    const bin = sdkReq.resolve(`${pkg}/claude`);
    await access(bin, fsConstants.X_OK);
    return bin;
  } catch (err) {
    log.warn('Could not resolve the Claude CLI binary; sessions run without a cgroup scope', {
      error: toError(err).message,
    });
    return null;
  }
}

let claudeBinPromise: Promise<string | null> | null = null;

/** The resolved Claude CLI binary, probed once and memoized (path is stable). */
function getClaudeBinary(): Promise<string | null> {
  if (!claudeBinPromise) claudeBinPromise = resolveClaudeBinary();
  return claudeBinPromise;
}

/**
 * Ensure the launcher script exists at its app-owned path and return it (or null
 * if it can't be written). Not memoized — cheap and re-verified per establishment
 * so a manually deleted / never-created launcher self-heals rather than bricking
 * every session with a spawn ENOENT. Whether systemd is actually usable is
 * decided at runtime *inside* the launcher (see SESSION_SCOPE_LAUNCHER), so this
 * only guarantees the file is present.
 */
async function ensureSessionLauncher(): Promise<string | null> {
  try {
    await mkdir(LAUNCHER_DIR, { recursive: true, mode: 0o700 });
    await writeFile(LAUNCHER_PATH, SESSION_SCOPE_LAUNCHER, { mode: 0o755 });
    await chmod(LAUNCHER_PATH, 0o755);
    return LAUNCHER_PATH;
  } catch (err) {
    log.warn('Could not write the session-scope launcher; session runs unwrapped', {
      error: toError(err).message,
    });
    return null;
  }
}

/**
 * Config to launch a session inside a cgroup scope, or null when unavailable (no
 * resolvable CLI binary, or the launcher can't be written) — the caller then
 * launches the session normally. Note: whether a scope is *actually* created is
 * decided at runtime by the launcher's own probe, so on a host without a usable
 * systemd user scope this still returns a config but the launcher runs the CLI
 * unwrapped.
 */
export async function getSessionScopeConfig(): Promise<SessionScopeConfig | null> {
  const claudeBin = await getClaudeBinary();
  if (!claudeBin) return null;
  const launcherPath = await ensureSessionLauncher();
  if (!launcherPath) return null;
  return { launcherPath, claudeBin };
}

/** A short random suffix distinguishing scope units across establishments. */
export function sessionScopeNonce(): string {
  return randomBytes(8).toString('hex');
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
    // Non-zero when the unit is already gone (the common case — the session may
    // have run unwrapped), so this is debug, not an error.
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
 *
 * The glob has no per-instance discriminator, so this MUST NOT run when another
 * app instance may be live as the same user — it would cgroup-kill that
 * instance's running sessions. The caller gates it to the single production
 * instance (see instrumentation.ts); a dev instance never sweeps.
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
