/**
 * Throwaway spike for the background-task reaper change (PR #425, issue #424).
 *
 * QUESTION: Does the SDK actually honor a `PreToolUse` hook's
 * `hookSpecificOutput.updatedInput` for the Bash tool — i.e. if the hook
 * rewrites the `command`, does the REWRITTEN command run instead of the
 * original? The reaper wraps backgrounded Bash commands this way; if the SDK
 * ignored updatedInput the feature would be a silent no-op.
 *
 * Method: ask Claude to run `echo original-marker`. A PreToolUse hook rewrites
 * any Bash command to instead write a REWRITTEN marker file. After the turn,
 * check which marker exists.
 *
 * Run (needs working Claude auth — CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY):
 *   pnpm tsx scripts/spike-pretooluse-rewrite.ts
 *
 * Exits 0 if the rewritten command ran (updatedInput honored), 1 otherwise.
 */

import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
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

  const options: Options = {
    cwd,
    permissionMode: 'bypassPermissions',
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: { type: 'preset', preset: 'claude_code' },
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
  console.log('REWRITTEN command ran:', rewrittenRan);
  console.log('ORIGINAL command ran:', originalRan);

  const ok = hookSawBash && rewrittenRan && !originalRan;
  console.log(
    ok
      ? '\nRESULT: PASS — SDK honors PreToolUse updatedInput for Bash (rewritten command ran).'
      : '\nRESULT: FAIL — updatedInput not honored as expected.'
  );
  process.exit(ok ? 0 : 1);
}

void main();
