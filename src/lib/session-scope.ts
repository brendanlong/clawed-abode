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

/**
 * Glob matching every session scope unit. Used at startup to stop scopes orphaned
 * by a previous server crash (which never ran teardown) before sessions revive.
 */
export const SESSION_SCOPE_UNIT_GLOB = 'clawed-session-*.scope';

/**
 * Transient systemd scope unit name for one query establishment. A per-establish
 * `nonce` keeps a stop→start (or resume) from colliding with a not-yet-torn-down
 * scope of the same session; the exact name is stored on session state so
 * teardown stops precisely this scope, while the glob above sweeps orphans.
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
 */
export const SESSION_SCOPE_LAUNCHER = `#!/bin/bash
if [ -n "\$${SESSION_SCOPE_ENV}" ] && systemd-run --user --scope --collect --quiet -- true >/dev/null 2>&1; then
  exec systemd-run --user --scope --collect --quiet -p TimeoutStopSec=10 \\
    --unit="\$${SESSION_SCOPE_ENV}" -- "\$${CLAUDE_BIN_ENV}" "\$@"
fi
exec "\$${CLAUDE_BIN_ENV}" "\$@"
`;
