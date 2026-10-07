/**
 * Session-level process reaping. Each session's Claude CLI subprocess (and thus
 * every process the agent spawns under it — foreground and backgrounded, incl.
 * daemons that double-fork to detach like Postgres via `pg_ctl start`) runs
 * inside a transient **systemd user scope** — its own cgroup. We deliberately do
 * NOT touch those processes mid-session; instead, when the session is torn down
 * (stop / delete / shutdown) the app stops the scope, and a cgroup stop reaps the
 * entire tree regardless of double-forking. See issue #424.
 *
 * The seam is the SDK's `pathToClaudeCodeExecutable`: we point it at a launcher
 * that execs the real CLI binary inside `systemd-run --user --scope`. If systemd
 * isn't available the launcher runs the CLI directly (unwrapped) — reaping is a
 * best-effort cleanup, never a hard requirement.
 */

/** Env var carrying the session's systemd scope unit name to the launcher. */
export const SESSION_SCOPE_ENV = 'CLAWED_SESSION_SCOPE';

/** Env var carrying the real Claude CLI binary path to the launcher. */
export const CLAUDE_BIN_ENV = 'CLAWED_CLAUDE_BIN';

/** Env var carrying the shared slice every session scope is placed in. */
export const SESSIONS_SLICE_ENV = 'CLAWED_SESSIONS_SLICE';

/**
 * The slice all session scopes share, so the resource limits on it cap agents
 * collectively (a leak in one session can't push the host into swap) while
 * sibling scopes split CPU fairly by default weight.
 */
export const SESSIONS_SLICE = 'clawed-sessions.slice';

/** Collective limits for {@link SESSIONS_SLICE}, in systemd's own value syntax. */
export interface SessionsSliceLimits {
  memoryMax: string;
  memorySwapMax: string;
  /** Unset means no CPU cap. */
  cpuQuota?: string;
}

/**
 * `systemctl set-property` assignments for the sessions slice. Every property is
 * always assigned (an unset CPU quota as an empty reset) because runtime
 * properties persist across app restarts until reboot, so dropping a limit from
 * the env must actively clear it.
 */
export function sessionsSliceProperties(limits: SessionsSliceLimits): string[] {
  return [
    `MemoryMax=${limits.memoryMax}`,
    `MemorySwapMax=${limits.memorySwapMax}`,
    `CPUQuota=${limits.cpuQuota ?? ''}`,
  ];
}

/**
 * Transient systemd scope unit name for one query establishment. A per-establish
 * `nonce` keeps a stop→start (or resume) from colliding with a not-yet-torn-down
 * scope of the same session; the exact name is recorded so teardown and the
 * startup orphan reap stop precisely this scope, never a glob.
 */
export function sessionScopeUnitName(sessionId: string, nonce: string): string {
  return `clawed-session-${sessionId}-${nonce}.scope`;
}

/**
 * Launcher the SDK spawns as `pathToClaudeCodeExecutable`. It runs the real
 * Claude CLI (`$CLAWED_CLAUDE_BIN`, resolved by the app) inside the session's
 * transient user scope (`$CLAWED_SESSION_SCOPE`), forwarding all CLI args and
 * stdio unchanged.
 *
 * The gate is a **runtime** probe — it actually creates a throwaway scope
 * (`systemd-run … -- true`) in this exact launch environment — not just a
 * `command -v` check. `exec` can't recover if the real `systemd-run` fails, so
 * we must know scope creation works *before* committing to it: if the probe
 * fails (no systemd-run, no user bus / linger after logout, no cgroup
 * delegation, a PATH/`XDG_RUNTIME_DIR` that differs from the app's probe env),
 * the launcher runs the CLI directly (unwrapped) instead of hard-failing the
 * session. This makes reaping best-effort and robust to environment drift after
 * the app's own start-time probe.
 *
 * `OOMPolicy=continue` matters once the slice's memory cap is hit: the kernel
 * kills the largest process, and systemd's default (`stop`) would then tear
 * down the victim's whole scope, ending the session instead of just the leak.
 */
export const SESSION_SCOPE_LAUNCHER = `#!/bin/bash
if [ -n "\$${SESSION_SCOPE_ENV}" ] && systemd-run --user --scope --collect --quiet -- true >/dev/null 2>&1; then
  exec systemd-run --user --scope --collect --quiet -p TimeoutStopSec=10 -p OOMPolicy=continue \\
    \${${SESSIONS_SLICE_ENV}:+"--slice=\$${SESSIONS_SLICE_ENV}"} --unit="\$${SESSION_SCOPE_ENV}" -- "\$${CLAUDE_BIN_ENV}" "\$@"
fi
exec "\$${CLAUDE_BIN_ENV}" "\$@"
`;
