import { z } from 'zod';

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
 * wrap: a non-empty `run_in_background` Bash call that isn't already wrapped.
 */
export function isBackgroundBashToWrap(toolName: string, toolInput: unknown): boolean {
  if (toolName !== 'Bash') return false;
  const parsed = bashBackgroundInputSchema.safeParse(toolInput);
  if (!parsed.success) return false;
  const { command, run_in_background } = parsed.data;
  return Boolean(run_in_background) && command.trim().length > 0 && !isAlreadyWrapped(command);
}

/**
 * Wrap a background command in a supervisor that reaps its full process tree when
 * it receives SIGTERM/SIGINT/SIGHUP (the signals the SDK uses to terminate a
 * background task). Without this, the SDK's SIGTERM hits only the direct child,
 * so a daemonized grandchild that double-forked to detach — e.g. Postgres via
 * `pg_ctl start` — is left orphaned (issue #424).
 *
 * The command runs inside a transient systemd **user scope** (its own cgroup);
 * the trap stops the scope, and a cgroup kill reaps every process in the tree
 * regardless of double-forking or `setsid`. This assumes an unprivileged systemd
 * user session with cgroup delegation (`systemd-run --user --scope`) is available
 * — true on the deployment host; if `systemd-run` is ever missing the command
 * fails loudly rather than running unreaped.
 *
 * The original command is embedded base64-encoded so its exact bytes survive with
 * no shell-quoting hazard, and the supervisor preserves the command's
 * stdout/stderr and exit code (verified empirically), so the SDK's BashOutput
 * view is unchanged.
 *
 * Known limitation: an untrappable SIGKILL to the supervisor cannot run the
 * teardown, so the scope would linger until its processes exit on their own. The
 * observed termination is SIGTERM (exit 143), which is trapped.
 */
export function wrapBackgroundCommand(command: string): string {
  const encoded = Buffer.from(command, 'utf8').toString('base64');
  // The command is decoded and run *inside* the scope. It must not appear in
  // systemd-run's ExecStart argv with any `$`, because systemd applies its own
  // ExecStart expansion there (`$$` → `$`, `$VAR` → env) and would corrupt the
  // shell script. So we pass the base64 (whose alphabet has no `$`) as a
  // positional arg and decode it with `$1` — a digit-led name systemd does not
  // treat as a variable — inside a fixed, `$$`-free launcher.
  const launcher = 'base64 -d <<<"$1" | bash';
  return [
    BACKGROUND_REAPER_MARKER,
    // Unique transient scope name per invocation; --collect auto-removes it.
    '__ca_unit="clawed-bg-$$-${RANDOM}.scope"',
    '__ca_reap() { systemctl --user stop "$__ca_unit" >/dev/null 2>&1; }',
    // Stopping the scope cgroup-kills every process in the tree (incl. daemonized
    // double-forks), then we exit 143 to mirror the SIGTERM the SDK expects.
    "trap '__ca_reap; exit 143' TERM INT HUP",
    // TimeoutStopSec bounds the stop: systemd SIGTERMs the whole cgroup, waits
    // this long for the command's own cleanup to run, then SIGKILLs it — so a
    // process that ignores SIGTERM can't wedge teardown near systemd's 90s default.
    `systemd-run --user --scope --collect --quiet -p TimeoutStopSec=10 --unit="$__ca_unit" -- bash -c '${launcher}' clawed-bg '${encoded}' &`,
    '__ca_pid=$!',
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
  toolInput: unknown
): Record<string, unknown> | null {
  if (!isBackgroundBashToWrap(toolName, toolInput)) return null;
  const { command } = bashBackgroundInputSchema.parse(toolInput);
  return {
    ...(toolInput as Record<string, unknown>),
    command: wrapBackgroundCommand(command),
  };
}
