/**
 * Does a user message pushed WHILE a run_in_background subagent is running get
 * answered promptly (interleaved), or only after the subagent finishes (queued)?
 *
 * Launch a background subagent that sleeps ~20s, wait for the main agent's end_turn
 * (composer would be free), then push a trivial second prompt and measure whether
 * the answer arrives well BEFORE the subagent's task_notification (interleaved) or
 * only AFTER it (queued).
 *
 * Run: eval "$(grep '^export CLAUDE_CODE_OAUTH_TOKEN' ~/.bashrc)"; pnpm tsx scripts/spike-concurrent-send.ts
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

const userMsg = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
});

const isTopLevel = (m: SDKMessage) => {
  const p = (m as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  return p === null || p === undefined;
};
const assistantText = (m: SDKMessage): string => {
  if (m.type !== 'assistant') return '';
  const c = (m as { message?: { content?: unknown } }).message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c))
    return c
      .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
      .map((b) => b.text)
      .join('');
  return '';
};

async function main() {
  const cwd = await mkdtemp(join(tmpdir(), 'spike-cc-'));
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
      'Use the Agent tool (a.k.a. Task) with run_in_background=true and subagent_type "general-purpose" ' +
        'to launch a subagent whose ONLY job is to run `sleep 20` then reply DONE. ' +
        'As soon as it is launched, reply with exactly STARTED and stop — do NOT wait or poll.'
    )
  );

  const start = Date.now();
  const t = () => ((Date.now() - start) / 1000).toFixed(1);
  let mainEndTurnAt: number | null = null;
  let secondSent = false;
  let answerAt: number | null = null;
  let taskNotificationAt: number | null = null;

  const it = q[Symbol.asyncIterator]();
  const deadline = start + 90_000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const race = await Promise.race([
      it.next().then((r) => ({ kind: 'next' as const, r })),
      new Promise<{ kind: 'timeout' }>((res) =>
        setTimeout(() => res({ kind: 'timeout' }), remaining)
      ),
    ]);
    if (race.kind === 'timeout') break;
    if (race.r.done) break;
    const m = race.r.value;
    const top = isTopLevel(m);
    const sub = (m as { subtype?: string }).subtype;
    const ev = (m as { event?: { type?: string; delta?: { stop_reason?: string } } }).event;

    // Detect the main agent finishing its first turn (end_turn) → push the 2nd msg.
    if (
      !secondSent &&
      top &&
      m.type === 'stream_event' &&
      ev?.type === 'message_delta' &&
      ev.delta?.stop_reason &&
      ev.delta.stop_reason !== 'tool_use' &&
      ev.delta.stop_reason !== 'pause_turn'
    ) {
      mainEndTurnAt = Date.now();
      secondSent = true;
      console.log(`[${t()}s] main agent end_turn → pushing 2nd message ("what is 2+2?")`);
      input.push(
        userMsg(
          `Ignore the background task. What is 2+2? Reply with exactly ${MARKER} then the number.`
        )
      );
    }

    if (top && m.type === 'assistant' && assistantText(m).includes(MARKER) && answerAt === null) {
      answerAt = Date.now();
      console.log(`[${t()}s] >>> got the answer to the 2nd message (${MARKER})`);
    }
    if (sub === 'task_notification' && taskNotificationAt === null) {
      taskNotificationAt = Date.now();
      console.log(`[${t()}s] subagent task_notification (sleep 20 finished)`);
    }
    if (answerAt !== null && taskNotificationAt !== null) break;
  }
  input.close();
  q.close();

  console.log('\n=== RESULT ===');
  if (mainEndTurnAt === null) {
    console.log('Never saw the main agent end its first turn — inconclusive.');
  } else if (answerAt === null) {
    console.log('Second message was NOT answered within the window → likely queued/blocked.');
  } else {
    const sinceSent = ((answerAt - mainEndTurnAt) / 1000).toFixed(1);
    const beforeSubagent = taskNotificationAt === null ? true : answerAt < taskNotificationAt;
    console.log(`2nd message answered ${sinceSent}s after it was sent.`);
    console.log(
      beforeSubagent
        ? 'INTERLEAVED: the answer arrived BEFORE the subagent finished → messages go through while it runs.'
        : 'QUEUED: the answer only arrived AFTER the subagent finished → composer is free but replies stall.'
    );
  }
}

void main();
