/**
 * If a user message is pushed mid-turn and the user then hits Stop (interrupt),
 * does the still-undelivered message run anyway? And what does interrupt() report?
 *
 * Answer: yes, it runs as its own turn immediately, and interrupt() resolves with
 * `{still_queued: [uuid]}` — which is why Stop follows up with cancelAsyncMessage.
 *
 * Run: eval "$(grep '^export CLAUDE_CODE_OAUTH_TOKEN' ~/.bashrc)"; pnpm tsx scripts/spike-interrupt-queued.ts
 */
import {
  query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
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

const summarize = (m: SDKMessage): string => {
  if (m.type === 'assistant') {
    const c = (m as { message?: { content?: unknown } }).message?.content;
    return (Array.isArray(c) ? c : [])
      .map((b) => {
        const ty = (b as { type?: string }).type;
        if (ty === 'text')
          return `text(${JSON.stringify((b as { text: string }).text.slice(0, 100))})`;
        if (ty === 'tool_use') return `tool_use(${(b as { name: string }).name})`;
        return String(ty);
      })
      .join(' | ');
  }
  if (m.type === 'result') return (m as { subtype: string }).subtype;
  if (m.type === 'system') return (m as { subtype?: string }).subtype ?? '';
  return '';
};

async function main() {
  const cwd = await mkdtemp(join(tmpdir(), 'spike-int-'));
  const options: Options = {
    cwd,
    permissionMode: 'bypassPermissions',
    includePartialMessages: false,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
  };
  const input = createPushable<SDKUserMessage>();
  const q = query({ prompt: input.iterable, options: { ...options, sessionId: randomUUID() } });

  const MARKER = 'PONG42';
  input.push({
    type: 'user',
    message: {
      role: 'user',
      content:
        'Run `sleep 8 && echo one` then `sleep 8 && echo two` with Bash, one at a time. Then reply ALLDONE.',
    },
    parent_tool_use_id: null,
  });

  const start = Date.now();
  const t = () => ((Date.now() - start) / 1000).toFixed(1);
  const secondUuid = randomUUID();

  setTimeout(() => {
    console.log(`[${t()}s] >>> push 2nd message (uuid=${secondUuid})`);
    input.push({
      type: 'user',
      message: { role: 'user', content: `What is 2+2? Reply exactly ${MARKER} then the number.` },
      parent_tool_use_id: null,
      uuid: secondUuid as SDKUserMessage['uuid'],
    });
  }, 5000);

  setTimeout(() => {
    console.log(`[${t()}s] >>> INTERRUPT`);
    void q.interrupt().then(
      (r) => console.log(`[${t()}s] interrupt() resolved: ${JSON.stringify(r)}`),
      (e) => console.log(`[${t()}s] interrupt() rejected: ${String(e)}`)
    );
  }, 6000);

  const it = q[Symbol.asyncIterator]();
  const deadline = start + 60_000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let h: ReturnType<typeof setTimeout> | undefined;
    const race = await Promise.race([
      it.next().then((r) => ({ kind: 'next' as const, r })),
      new Promise<{ kind: 'timeout' }>((res) => {
        h = setTimeout(() => res({ kind: 'timeout' }), Math.min(remaining, 25_000));
      }),
    ]);
    clearTimeout(h);
    if (race.kind === 'timeout') {
      console.log(`[${t()}s] (no messages for 25s — stopping)`);
      break;
    }
    if (race.r.done) break;
    const m = race.r.value;
    if (['assistant', 'user', 'result', 'system'].includes(m.type)) {
      console.log(`[${t()}s] ${m.type}: ${summarize(m)}`);
    } else if (m.type !== 'stream_event') {
      console.log(`[${t()}s] RAW ${JSON.stringify(m)}`);
    }
  }
  input.close();
  q.close();
}

void main();
