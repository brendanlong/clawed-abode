/**
 * Thin wrapper around tmux for the abode CLI.
 *
 * All abode sessions live on a dedicated tmux server (socket name "abode") so
 * key bindings and options never interfere with the user's own tmux setup.
 * One tmux session per abode session, named `abode-{sessionId}`.
 */

import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Socket name for the dedicated abode tmux server. */
export const ABODE_TMUX_SOCKET = 'abode';

const TMUX_SESSION_PREFIX = 'abode-';

export function tmuxSessionName(sessionId: string): string {
  return `${TMUX_SESSION_PREFIX}${sessionId}`;
}

async function tmux(socket: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['-L', socket, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Apply server-wide options for the abode tmux server. Idempotent; called
 * after session creation since global options only persist while the server
 * is running (it exits when the last session closes).
 *
 * - status off: hand the full screen to Claude Code
 * - F12 detaches: single-key way back to the hub (Ctrl-b d also works)
 * - mouse on: wheel/touch scrolling enters copy mode naturally
 */
async function applyServerOptions(socket: string): Promise<void> {
  await tmux(socket, ['set-option', '-g', 'status', 'off']);
  await tmux(socket, ['set-option', '-g', 'mouse', 'on']);
  await tmux(socket, ['bind-key', '-n', 'F12', 'detach-client']);
}

export interface CreateTmuxSessionOptions {
  name: string;
  cwd: string;
  /** Extra environment variables for the session (on top of the login env) */
  env?: Record<string, string>;
  /** Command argv to run in the session (passed to execvp directly, no shell) */
  command: string[];
  socket?: string;
}

/**
 * Create a detached tmux session running the given command.
 */
export async function createTmuxSession(options: CreateTmuxSessionOptions): Promise<void> {
  const socket = options.socket ?? ABODE_TMUX_SOCKET;
  const args = ['new-session', '-d', '-s', options.name, '-c', options.cwd];

  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push('-e', `${key}=${value}`);
  }

  // Multiple arguments are exec'd directly by tmux — no shell, no quoting issues
  args.push('--', ...options.command);

  await tmux(socket, args);

  // Best-effort: if the command exited immediately the server may already be
  // gone (exit-empty), and there is nothing left to configure.
  try {
    await applyServerOptions(socket);
  } catch {
    // Server no longer running
  }
}

/**
 * List the names of all live abode tmux sessions.
 * Returns an empty set when the server isn't running.
 */
export async function listTmuxSessions(socket = ABODE_TMUX_SOCKET): Promise<Set<string>> {
  try {
    const stdout = await tmux(socket, ['list-sessions', '-F', '#{session_name}']);
    return new Set(stdout.split('\n').filter(Boolean));
  } catch {
    // No server running (or no sessions) — treat as empty
    return new Set();
  }
}

/**
 * Check whether a tmux session with the exact given name exists.
 */
export async function hasTmuxSession(name: string, socket = ABODE_TMUX_SOCKET): Promise<boolean> {
  try {
    // `=` prefix forces exact-match (plain -t does prefix matching)
    await tmux(socket, ['has-session', '-t', `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a tmux session if it exists.
 */
export async function killTmuxSession(name: string, socket = ABODE_TMUX_SOCKET): Promise<void> {
  try {
    await tmux(socket, ['kill-session', '-t', `=${name}`]);
  } catch {
    // Already gone — nothing to do
  }
}

/**
 * Attach to a tmux session, handing the terminal over until the user
 * detaches (F12 / Ctrl-b d) or the session's process exits.
 */
export function attachTmuxSession(name: string, socket = ABODE_TMUX_SOCKET): void {
  spawnSync('tmux', ['-L', socket, 'attach-session', '-t', `=${name}`], {
    stdio: 'inherit',
  });
}

/**
 * Kill the entire abode tmux server (used by tests).
 */
export async function killTmuxServer(socket = ABODE_TMUX_SOCKET): Promise<void> {
  try {
    await tmux(socket, ['kill-server']);
  } catch {
    // Server not running
  }
}
