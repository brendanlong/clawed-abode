/**
 * Can we push a user message into the streaming-input query WHILE a turn is
 * actively generating, and does the agent see it mid-turn (steering) or only
 * after the turn ends? And is there any observable signal on the output stream
 * telling us WHEN the CLI actually handed it to the model?
 *
 * Sends a long multi-step task, then ~4s in (mid-turn, before any end_turn)
 * pushes a second message. Logs every top-level message with a timestamp.
 *
 * Answer: the CLI folds it into the RUNNING turn at the next tool-result boundary,
 * and reports the handoff as `command_lifecycle` queued → started → completed.
 *
 * Run: eval "$(grep '^export CLAUDE_CODE_OAUTH_TOKEN' ~/.bashrc)"; pnpm tsx scripts/spike-midturn-send.ts
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

const userMsg = (text: string, extra: Partial<SDKUserMessage> = {}): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
  ...extra,
});

const isTopLevel = (m: SDKMessage) => {
  const p = (m as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  return p === null || p === undefined;
};

const summarize = (m: SDKMessage): string => {
  if (m.type === 'assistant') {
    const c = (m as { message?: { content?: unknown } }).message?.content;
    const blocks = Array.isArray(c) ? c : [];
    return blocks
      .map((b) => {
        const t = (b as { type?: string }).type;
        if (t === 'text')
          return `text(${JSON.stringify((b as { text: string }).text.slice(0, 120))})`;
        if (t === 'tool_use')
          return `tool_use(${(b as { name: string }).name}: ${JSON.stringify((b as { input: unknown }).input).slice(0, 100)})`;
        if (t === 'thinking') return 'thinking(...)';
        return String(t);
      })
      .join(' | ');
  }
  if (m.type === 'user') {
    const c = (m as { message?: { content?: unknown } }).message?.content;
    const s = typeof c === 'string' ? c : JSON.stringify(c);
    return `${s.slice(0, 160)}`;
  }
  if (m.type === 'result') return `${(m as { subtype: string }).subtype}`;
  if (m.type === 'system') return `${(m as { subtype?: string }).subtype ?? ''}`;
  return '';
};

async function main() {
  const cwd = await mkdtemp(join(tmpdir(), 'spike-mid-'));
  const options: Options = {
    cwd,
    permissionMode: 'bypassPermissions',
    includePartialMessages: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
  };
  const input = createPushable<SDKUserMessage>();
  const q = query({ prompt: input.iterable, options: { ...options, sessionId: randomUUID() } });

  const MARKER = 'PONG42';
  input.push(
    userMsg(
      'Run these Bash commands one at a time, in order, waiting for each to finish before ' +
        'starting the next: `sleep 6 && echo one`, `sleep 6 && echo two`, `sleep 6 && echo three`. ' +
        'After all three, reply with exactly ALLDONE.'
    )
  );

  const start = Date.now();
  const t = () => ((Date.now() - start) / 1000).toFixed(1);

  const secondUuid = randomUUID();
  let secondSent = false;
  const sendSecond = () => {
    if (secondSent) return;
    secondSent = true;
    console.log(`[${t()}s] >>> PUSHING 2nd message mid-turn (uuid=${secondUuid})`);
    input.push(
      userMsg(
        `Ignore what you are doing. What is 2+2? Reply with exactly ${MARKER} then the number.`,
        { uuid: secondUuid as SDKUserMessage['uuid'] }
      )
    );
  };

  // Fire the second message 4s in — well inside the first `sleep 6`.
  const timer = setTimeout(sendSecond, 4000);

  const it = q[Symbol.asyncIterator]();
  const deadline = start + 120_000;
  let sawMarker = false;
  let firstResultAt: number | null = null;
  let markerAt: number | null = null;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const race = await Promise.race([
      it.next().then((r) => ({ kind: 'next' as const, r })),
      new Promise<{ kind: 'timeout' }>((res) => {
        timeoutHandle = setTimeout(() => res({ kind: 'timeout' }), remaining);
      }),
    ]);
    clearTimeout(timeoutHandle);
    if (race.kind === 'timeout') break;
    if (race.r.done) break;
    const m = race.r.value;
    if (m.type === 'stream_event') continue;
    const tag = isTopLevel(m) ? '' : ' (sub)';
    if (!['assistant', 'user', 'result', 'system'].includes(m.type)) {
      console.log(`[${t()}s] RAW ${JSON.stringify(m)}`);
      continue;
    }
    console.log(`[${t()}s] ${m.type}${tag}: ${summarize(m)}`);

    if (m.type === 'result' && firstResultAt === null) firstResultAt = Date.now();
    if (m.type === 'assistant' && summarize(m).includes(MARKER) && !sawMarker) {
      sawMarker = true;
      markerAt = Date.now();
      console.log(`[${t()}s] >>> ANSWER to 2nd message arrived`);
    }
    if (sawMarker && firstResultAt !== null && Date.now() - markerAt! > 3000) break;
  }
  clearTimeout(timer);
  input.close();
  q.close();

  console.log('\n=== RESULT ===');
  if (markerAt === null) console.log('2nd message never answered within the window.');
  else if (firstResultAt === null || markerAt < firstResultAt)
    console.log('MID-TURN: answered BEFORE the first turn produced a result.');
  else
    console.log(
      `AFTER-TURN: answered ${((markerAt - firstResultAt) / 1000).toFixed(1)}s after the first turn's result.`
    );
}

void main();
