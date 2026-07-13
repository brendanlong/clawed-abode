import { describe, it, expect } from 'vitest';
import type { HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { isAlreadyWrapped } from '@/lib/background-command';
import { backgroundReaperHook } from './background-reaper';

const base = { session_id: 's', transcript_path: '', cwd: '' };

const preToolUse = (toolName: string, toolInput: unknown): HookInput => ({
  ...base,
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: 'tu_test',
});

describe('backgroundReaperHook', () => {
  it('rewrites a backgrounded Bash command, preserving other fields', async () => {
    const out = (await backgroundReaperHook(
      preToolUse('Bash', {
        command: 'pnpm services',
        run_in_background: true,
        description: 'svc',
      })
    )) as SyncHookJSONOutput;
    const hso = out.hookSpecificOutput as
      | { hookEventName: string; updatedInput?: Record<string, unknown> }
      | undefined;
    expect(hso?.hookEventName).toBe('PreToolUse');
    const updated = hso?.updatedInput;
    expect(updated).toBeDefined();
    expect(updated!.description).toBe('svc');
    expect(updated!.run_in_background).toBe(true);
    expect(isAlreadyWrapped(updated!.command as string)).toBe(true);
  });

  it('passes through a foreground Bash command untouched', async () => {
    expect(await backgroundReaperHook(preToolUse('Bash', { command: 'ls' }))).toEqual({});
  });

  it('passes through non-Bash tools and non-PreToolUse events untouched', async () => {
    expect(
      await backgroundReaperHook(preToolUse('Read', { command: 'x', run_in_background: true }))
    ).toEqual({});
    const postToolUse: HookInput = {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'x', run_in_background: true },
      tool_response: 'ok',
      tool_use_id: 'tu',
    };
    expect(await backgroundReaperHook(postToolUse)).toEqual({});
  });
});
