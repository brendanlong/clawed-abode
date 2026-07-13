import { z } from 'zod';

/**
 * How a backgrounded Bash command's process tree is torn down when the SDK
 * terminates the task (it sends SIGTERM to the direct child — exit 143 — but
 * does not reap the child's descendants, so a daemonized grandchild that
 * double-forked to detach, e.g. Postgres via `pg_ctl start`, is left orphaned).
 * See issue #424.
 *
 * - `cgroup`: run the command inside a transient systemd **user scope** (its own
 *   cgroup) and stop the scope on termination. A cgroup kill reaps every process
 *   in the tree regardless of double-forking or `setsid` — the robust option.
 *   Requires an unprivileged systemd user session with cgroup delegation
 *   (`systemd-run --user --scope`), which the app probes for once at runtime.
 * - `process-group`: fallback when no user scope is available. Run the command
 *   as a job in its own process group (`set -m`) and, on termination, signal the
 *   whole group (SIGTERM, grace, then SIGKILL). This lets the command's own
 *   shell `trap` handlers run to completion (the common `pnpm services` case
 *   where the trap does `pg_ctl stop`), but a grandchild that double-forked out
 *   of the group still escapes — best-effort only.
 */
export type ReaperMode = 'cgroup' | 'process-group';

/**
 * Sentinel comment placed at the top of a wrapped command. Used to detect (and
 * skip re-wrapping) a command we've already supervised, so the wrapper is
 * idempotent even if the same command string flows through the hook twice.
 */
export const BACKGROUND_REAPER_MARKER = '# clawed-abode-bg-reaper';

/**
 * Bash tool input we care about. The tool carries other fields (`description`,
 * `timeout`, …) we must preserve; we only ever override `command`, so callers
 * spread the original input rather than reconstructing it from this schema.
 */
const bashBackgroundInputSchema = z.object({
  command: z.string(),
  run_in_background: z.boolean().optional(),
});

/** True when `command` is already a reaper-wrapped command (idempotency guard). */
export function isAlreadyWrapped(command: string): boolean {
  return command.includes(BACKGROUND_REAPER_MARKER);
}

/**
 * Whether a PreToolUse Bash invocation is a background command that we should
 * wrap. Kept as a cheap, pure predicate so the hook can gate the (impure,
 * process-spawning) reaper-mode probe on it — a foreground Bash call never
 * triggers the probe.
 */
export function isBackgroundBashToWrap(toolName: string, toolInput: unknown): boolean {
  if (toolName !== 'Bash') return false;
  const parsed = bashBackgroundInputSchema.safeParse(toolInput);
  if (!parsed.success) return false;
  const { command, run_in_background } = parsed.data;
  return Boolean(run_in_background) && command.trim().length > 0 && !isAlreadyWrapped(command);
}

/**
 * Wrap a background command in a supervisor that reaps its full process tree
 * when it receives SIGTERM/SIGINT/SIGHUP (the signals the SDK uses to terminate
 * a background task). The original command is embedded base64-encoded so its
 * exact bytes survive without any shell-quoting hazard, and run via
 * `bash -c "$(… | base64 -d)"`.
 *
 * The supervisor preserves the command's stdout/stderr and exit code (verified
 * empirically for both modes), so the SDK's BashOutput view is unchanged.
 *
 * Known limitation: an untrappable SIGKILL to the supervisor cannot run the
 * teardown, so a `cgroup`-mode scope would linger until its processes exit on
 * their own. The observed termination is SIGTERM (exit 143), which is trapped.
 */
export function wrapBackgroundCommand(command: string, mode: ReaperMode): string {
  const encoded = Buffer.from(command, 'utf8').toString('base64');

  if (mode === 'cgroup') {
    // The command is decoded and run *inside* the scope. It must not appear in
    // systemd-run's ExecStart argv with any `$`, because systemd applies its own
    // ExecStart expansion there (`$$` → `$`, `$VAR` → env) and would corrupt the
    // shell script. So we pass the base64 (whose alphabet has no `$`) as a
    // positional arg and decode it with `$1` — a digit-led name systemd does not
    // treat as a variable — inside a fixed, `$$`-free launcher.
    const launcher = 'base64 -d <<<"$1" | bash';
    return [
      `${BACKGROUND_REAPER_MARKER} (cgroup)`,
      // Unique transient scope name per invocation; --collect auto-removes it.
      '__ca_unit="clawed-bg-$$-${RANDOM}.scope"',
      '__ca_reap() { systemctl --user stop "$__ca_unit" >/dev/null 2>&1; }',
      // Stopping the scope cgroup-kills every process in the tree (incl. daemonized
      // double-forks), then we exit 143 to mirror the SIGTERM the SDK expects.
      "trap '__ca_reap; exit 143' TERM INT HUP",
      `systemd-run --user --scope --collect --quiet --unit="$__ca_unit" -- bash -c '${launcher}' clawed-bg '${encoded}' &`,
      '__ca_pid=$!',
      'wait "$__ca_pid"',
    ].join('\n');
  }

  return [
    `${BACKGROUND_REAPER_MARKER} (process-group)`,
    // Job control puts the async job in its own process group whose id == its pid,
    // so `kill -- -$pid` signals the whole group. (No job-control stderr noise in
    // a non-interactive shell — verified.) No systemd here, so the outer shell can
    // safely command-substitute the base64 payload into a single bash -c argument.
    'set -m',
    `bash -c "$(printf %s '${encoded}' | base64 -d)" &`,
    '__ca_pid=$!',
    // SIGTERM the group (lets the command's own cleanup traps run), wait up to
    // ~10s for it to exit, then SIGKILL the group as a backstop.
    '__ca_reap() { kill -TERM -"$__ca_pid" 2>/dev/null; for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 -"$__ca_pid" 2>/dev/null || return; sleep 1; done; kill -KILL -"$__ca_pid" 2>/dev/null; }',
    "trap '__ca_reap; exit 143' TERM INT HUP",
    'wait "$__ca_pid"',
  ].join('\n');
}

/**
 * Compute the rewritten Bash tool input for a background command, or `null` when
 * the invocation should be left untouched (not Bash, not backgrounded, empty,
 * or already wrapped). Preserves every original input field, overriding only
 * `command`.
 */
export function computeBackgroundBashRewrite(
  toolName: string,
  toolInput: unknown,
  mode: ReaperMode
): Record<string, unknown> | null {
  if (!isBackgroundBashToWrap(toolName, toolInput)) return null;
  const { command } = bashBackgroundInputSchema.parse(toolInput);
  return {
    ...(toolInput as Record<string, unknown>),
    command: wrapBackgroundCommand(command, mode),
  };
}
