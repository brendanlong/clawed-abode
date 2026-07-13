/**
 * Throwaway spike for the background-task reaper change (PR #425, issue #424).
 *
 * QUESTION: Does the SDK actually honor a `PreToolUse` hook's
 * `hookSpecificOutput.updatedInput` for the Bash tool — i.e. if the hook
 * rewrites the `command`, does the REWRITTEN command run instead of the
 * original? The reaper wraps backgrounded Bash commands this way; if the SDK
 * ignored updatedInput the feature would be a silent no-op.
 *
 * Method: ask Claude to run a Bash command that writes an ORIGINAL marker. A
 * PreToolUse hook rewrites any Bash command to instead write a REWRITTEN marker
 * file. After the turn, check which marker exists.
 *
 * IMPORTANT: this mirrors the app's production config — a `canUseTool` that
 * returns `{ behavior: 'allow', updatedInput: input }` for Bash — because that
 * interaction is load-bearing. The concern was that canUseTool's `updatedInput:
 * input` re-emit could clobber the PreToolUse rewrite.
 *
 * OBSERVED (SDK 0.3.196): canUseTool's `input` param is the ORIGINAL command
 * (canUseTool does NOT see the PreToolUse rewrite), yet the REWRITTEN command is
 * what actually runs — i.e. the SDK applies the PreToolUse `updatedInput` at
 * execution independently of, and with precedence over, canUseTool's re-emit. So
 * the reaper wrap survives the app's canUseTool. The safety property this spike
 * asserts is therefore simply "the rewrite reaches execution" (rewritten ran,
 * original did not); the canUseTool observation is logged as informational.
 *
 * Run (needs working Claude auth — CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY):
 *   pnpm tsx scripts/spike-pretooluse-rewrite.ts
 *
 * Exits 0 if the rewritten command ran (updatedInput honored end-to-end), 1 otherwise.
 */

import {
  query,
  type Options,
  type PermissionResult,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function drainUntil(
  q: AsyncIterable<SDKMessage>,
  deadlineMs: number,
  onMessage: (m: SDKMessage) => boolean | void
): Promise<'ended' | 'timeout' | 'stopped'> {
  const it = q[Symbol.asyncIterator]();
  const end = Date.now() + deadlineMs;
  for (;;) {
    const remaining = end - Date.now();
    if (remaining <= 0) return 'timeout';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const race = await Promise.race([
      it.next().then((r) => ({ kind: 'next' as const, r })),
      new Promise<{ kind: 'timeout' }>((res) => {
        timer = setTimeout(() => res({ kind: 'timeout' }), remaining);
      }),
    ]);
    clearTimeout(timer);
    if (race.kind === 'timeout') return 'timeout';
    if (race.r.done) return 'ended';
    if (onMessage(race.r.value) === true) return 'stopped';
  }
}

async function main() {
  const cwd = await mkdtemp(join(tmpdir(), 'spike-pretool-'));
  const rewrittenMarker = join(cwd, 'REWRITTEN.marker');
  const originalMarker = join(cwd, 'ORIGINAL.marker');

  let hookSawBash = false;

  let canUseToolSawRewritten = false;

  const options: Options = {
    cwd,
    permissionMode: 'bypassPermissions',
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: { type: 'preset', preset: 'claude_code' },
    // Mirror buildSdkOptions: allow all tools and re-emit the (hopefully already
    // PreToolUse-rewritten) input. This is where a wrong ordering would clobber.
    canUseTool: async (toolName, input): Promise<PermissionResult> => {
      if (toolName === 'Bash') {
        const cmd = (input as { command?: string }).command ?? '';
        if (cmd.includes(rewrittenMarker)) canUseToolSawRewritten = true;
      }
      return { behavior: 'allow', updatedInput: input };
    },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return {};
              hookSawBash = true;
              // Rewrite whatever command to instead touch the REWRITTEN marker.
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  updatedInput: {
                    ...(input.tool_input as Record<string, unknown>),
                    command: `printf rewritten > '${rewrittenMarker}'`,
                  },
                },
              };
            },
          ],
        },
      ],
    },
  };

  const q = query({
    prompt: `Run exactly this shell command with the Bash tool: printf original > '${originalMarker}'. Then stop.`,
    options,
  });

  const outcome = await drainUntil(q, 120_000, (m) => {
    if (m.type === 'result') return true;
  });

  const rewrittenRan = existsSync(rewrittenMarker);
  const originalRan = existsSync(originalMarker);
  console.log('drain outcome:', outcome);
  console.log('hook saw a Bash call:', hookSawBash);
  console.log('canUseTool saw the REWRITTEN command (informational):', canUseToolSawRewritten);
  console.log('REWRITTEN command ran:', rewrittenRan);
  console.log('ORIGINAL command ran:', originalRan);

  // Safety property: the PreToolUse rewrite reaches execution even though the
  // app's canUseTool re-emits `updatedInput: input` (the original).
  const ok = hookSawBash && rewrittenRan && !originalRan;
  console.log(
    ok
      ? '\nRESULT: PASS — the PreToolUse rewrite survives canUseTool and runs (feature is not a no-op).'
      : '\nRESULT: FAIL — the PreToolUse rewrite did not survive to execution.'
  );
  process.exit(ok ? 0 : 1);
}

void main();
