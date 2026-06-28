/**
 * Diagnostic spike: can a PostToolUse hook sanitize/replace tool OUTPUT before
 * the model sees it, under our real config (bypassPermissions + streaming input)?
 *
 * The SDK types say PostToolUseHookSpecificOutput.updatedToolOutput "Replaces the
 * tool output before it is sent to the model" for all tools. This verifies that:
 *   1. PostToolUse fires at all in streaming mode with bypassPermissions.
 *   2. The real shape of `tool_response` for Bash / Read (so the sanitizer knows
 *      where the text lives).
 *   3. `updatedToolOutput` is actually honored — we replace the Bash output with a
 *      sentinel and check the model echoes the sentinel, not the real output.
 *
 * Run: eval "$(grep '^export CLAUDE_CODE_OAUTH_TOKEN' ~/.bashrc)"; pnpm tsx scripts/spike-tool-output-hook.ts
 */
import {
  query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
  type HookInput,
  type PostToolUseHookInput,
  type HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function createPushable<T>() {
  const queue: T[] = [];
  let resolveNext: (() => void) | null = null;
  let closed = false;
  const iterable: AsyncIterable<T> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (closed) return;
        await new Promise<void>((r) => (resolveNext = r));
      }
    },
  };
  return {
    iterable,
    push(v: T) {
      queue.push(v);
      resolveNext?.();
      resolveNext = null;
    },
    close() {
      closed = true;
      resolveNext?.();
      resolveNext = null;
    },
  };
}

function userMsg(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

const SENTINEL = 'SENTINEL_REPLACED_47281';

async function main() {
  const cwd = await mkdtemp(join(tmpdir(), 'spike-hook-'));
  let postToolUseFired = false;

  const options: Options = {
    cwd,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: { type: 'preset', preset: 'claude_code' },
    hooks: {
      PostToolUse: [
        {
          hooks: [
            async (input: HookInput): Promise<HookJSONOutput> => {
              const i = input as PostToolUseHookInput;
              postToolUseFired = true;
              console.log(
                `\n[PostToolUse] tool=${i.tool_name} response typeof=${typeof i.tool_response}`
              );
              console.log(`  tool_response=${JSON.stringify(i.tool_response)?.slice(0, 600)}`);
              if (i.tool_name === 'Bash') {
                // Replacement must preserve the tool's structured shape: replace
                // the text fields in place rather than returning a bare string.
                const resp =
                  typeof i.tool_response === 'object' && i.tool_response !== null
                    ? (i.tool_response as Record<string, unknown>)
                    : {};
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PostToolUse',
                    updatedToolOutput: { ...resp, stdout: SENTINEL },
                  },
                };
              }
              return {};
            },
          ],
        },
      ],
    },
  };

  const input = createPushable<SDKUserMessage>();
  const q = query({ prompt: input.iterable, options: { ...options, sessionId: randomUUID() } });

  input.push(
    userMsg(
      'Run exactly this shell command with the Bash tool: `echo hello-from-bash`. ' +
        'Then reply with ONLY the exact stdout you observed from that command, nothing else.'
    )
  );

  const start = Date.now();
  const deadline = start + 90_000;
  let finalText = '';
  const it = q[Symbol.asyncIterator]();
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const race = await Promise.race([
      it.next().then((r) => ({ kind: 'next' as const, r })),
      new Promise<{ kind: 'timeout' }>((res) => {
        timer = setTimeout(() => res({ kind: 'timeout' }), remaining);
      }),
    ]);
    clearTimeout(timer);
    if (race.kind === 'timeout') break;
    if (race.r.done) break;
    const m: SDKMessage = race.r.value;
    if (m.type === 'assistant') {
      const content = (m as { message?: { content?: Array<{ type?: string; text?: string }> } })
        .message?.content;
      if (Array.isArray(content)) {
        for (const b of content) if (b.type === 'text' && b.text) finalText += b.text;
      }
    }
    if (m.type === 'result') break;
  }
  input.close();
  q.close();

  console.log('\n=== SUMMARY ===');
  console.log(`PostToolUse hook fired: ${postToolUseFired}`);
  console.log(`final model text: ${JSON.stringify(finalText.trim())}`);
  const sawSentinel = finalText.includes(SENTINEL);
  const sawReal = finalText.includes('hello-from-bash');
  console.log(`model echoed SENTINEL (replacement honored): ${sawSentinel}`);
  console.log(`model echoed real output (replacement IGNORED): ${sawReal}`);
  console.log(
    sawSentinel && !sawReal
      ? '\nCONFIRMED: updatedToolOutput replaces tool output before the model sees it.'
      : '\nINCONCLUSIVE — inspect logs above.'
  );
}

void main();
