import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { createLogger, toError } from '@/lib/logger';
import { computeBackgroundBashRewrite } from '@/lib/background-command';

const log = createLogger('background-reaper');

/**
 * `PreToolUse` hook wired into the session query (see `buildSdkOptions`). When a
 * Bash tool call is backgrounded (`run_in_background`), rewrite its `command` to
 * run inside a transient systemd user scope so its whole process tree is reaped
 * on termination — fixing orphaned daemonized grandchildren (issue #424). All
 * other tool calls pass through untouched. Fails open: any error logs and returns
 * `{}` so a hook failure can never block a command from running.
 */
export async function backgroundReaperHook(input: HookInput): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse') return {};
  try {
    const updatedInput = computeBackgroundBashRewrite(input.tool_name, input.tool_input);
    if (!updatedInput) return {};
    log.info('Wrapping background Bash command for process-tree reaping', {
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
