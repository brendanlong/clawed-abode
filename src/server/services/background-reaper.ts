import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { createLogger, toError } from '@/lib/logger';
import {
  computeBackgroundBashRewrite,
  isBackgroundBashToWrap,
  type ReaperMode,
} from '@/lib/background-command';

const execFileAsync = promisify(execFile);
const log = createLogger('background-reaper');

let reaperModePromise: Promise<ReaperMode> | null = null;

/**
 * Probe whether we can run background commands in an unprivileged systemd user
 * scope (own cgroup). A short-lived scope around `true` succeeds only when the
 * account has a systemd user session with cgroup delegation; otherwise we fall
 * back to process-group signaling. The scope is `--collect`ed so the probe
 * leaves nothing behind.
 */
async function probeCgroupSupport(): Promise<boolean> {
  try {
    await execFileAsync(
      'systemd-run',
      ['--user', '--scope', '--collect', '--quiet', '--', 'true'],
      { timeout: 5000 }
    );
    return true;
  } catch (err) {
    log.info('systemd user scope unavailable; background tasks use process-group reaping', {
      error: toError(err).message,
    });
    return false;
  }
}

/**
 * Reaper mode for this host, probed once and memoized (capability doesn't change
 * over the process lifetime). Exposed for tests to reset via {@link resetReaperModeCache}.
 */
export async function detectReaperMode(): Promise<ReaperMode> {
  if (!reaperModePromise) {
    reaperModePromise = probeCgroupSupport().then((supported) => {
      const mode: ReaperMode = supported ? 'cgroup' : 'process-group';
      log.info('Background-task reaper mode detected', { mode });
      return mode;
    });
  }
  return reaperModePromise;
}

/** Test-only: clear the memoized probe so a fresh detection runs. */
export function resetReaperModeCache(): void {
  reaperModePromise = null;
}

/**
 * `PreToolUse` hook wired into the session query (see `buildSdkOptions`). When a
 * Bash tool call is backgrounded (`run_in_background`), rewrite its `command` to
 * run under a supervisor that reaps the whole process tree on termination —
 * fixing orphaned daemonized grandchildren (issue #424). All other tool calls
 * pass through untouched. Fails open: any error logs and returns `{}` so a hook
 * failure can never block a command from running.
 */
export async function backgroundReaperHook(input: HookInput): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse') return {};
  // Gate the (process-spawning) capability probe on the cheap pure predicate so
  // a foreground Bash call never triggers it.
  if (!isBackgroundBashToWrap(input.tool_name, input.tool_input)) return {};
  try {
    const mode = await detectReaperMode();
    const updatedInput = computeBackgroundBashRewrite(input.tool_name, input.tool_input, mode);
    if (!updatedInput) return {};
    log.info('Wrapping background Bash command for process-tree reaping', {
      mode,
      toolUseId: input.tool_use_id,
    });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput,
      },
    };
  } catch (err) {
    log.warn(
      'Background-task reaper hook failed; running command unwrapped',
      { tool: input.tool_name },
      toError(err)
    );
    return {};
  }
}
