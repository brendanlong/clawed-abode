/**
 * Diagnostic spike: what is the message shape for a run_in_background SUBAGENT?
 *
 * Our reducer keys `turnActive` off top-level (parent_tool_use_id == null)
 * assistant/stream_event. Backgrounded Bash streams no inner assistant messages,
 * so it never flips turnActive — but a background Agent/subagent streams its OWN
 * assistant/stream_event messages. If those arrive top-level, turnActive would be
 * stuck true while only a background task runs (the reported bug).
 *
 * This logs, for every message: type[:subtype], parent_tool_use_id, subagent_type,
 * and flags the main turn's terminal result, so we can see whether subagent
 * traffic is tagged (parent set / subagent_type set) or leaks in as top-level.
 *
 * Run: eval "$(grep '^export CLAUDE_CODE_OAUTH_TOKEN' ~/.bashrc)"; pnpm tsx scripts/spike-background-agent.ts
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

function userMsg(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

function meta(m: SDKMessage): string {
  const sub = (m as { subtype?: string }).subtype;
  const parent = (m as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  const subagent = (m as { subagent_type?: string }).subagent_type;
  const topLevel = parent === null || parent === undefined;
  // For assistant messages, surface stop_reason + whether it contains tool_use.
  let extra = '';
  if (m.type === 'assistant') {
    const inner = (
      m as { message?: { stop_reason?: string | null; content?: Array<{ type?: string }> } }
    ).message;
    const hasToolUse =
      Array.isArray(inner?.content) && inner.content.some((b) => b.type === 'tool_use');
    extra = `  stop_reason=${inner?.stop_reason ?? 'null'}${hasToolUse ? ' [tool_use]' : ''}`;
  }
  if (m.type === 'stream_event') {
    const ev = (m as { event?: { type?: string; delta?: { stop_reason?: string } } }).event;
    extra = `  event=${ev?.type ?? '?'}${ev?.delta?.stop_reason ? ` delta.stop_reason=${ev.delta.stop_reason}` : ''}`;
  }
  return (
    [
      `${m.type}${sub ? ':' + sub : ''}`,
      `parent=${parent ?? 'null'}`,
      subagent ? `subagent_type=${subagent}` : null,
      topLevel ? 'TOP-LEVEL' : 'sub',
    ]
      .filter(Boolean)
      .join('  ') + extra
  );
}

async function main() {
  const cwd = await mkdtemp(join(tmpdir(), 'spike-bg-'));
  const options: Options = {
    cwd,
    permissionMode: 'bypassPermissions',
    includePartialMessages: true, // the real app runs with partials; look for message_delta stop_reason
    systemPrompt: { type: 'preset', preset: 'claude_code' },
  };
  const input = createPushable<SDKUserMessage>();
  const q = query({ prompt: input.iterable, options: { ...options, sessionId: randomUUID() } });

  input.push(
    userMsg(
      'Use the Agent tool (a.k.a. Task) with run_in_background set to true and subagent_type "general-purpose" ' +
        'to launch a subagent whose ONLY job is to run the shell command `sleep 8` and then reply DONE. ' +
        'As soon as you have launched it, reply with exactly STARTED and stop — do not wait for it, do not poll. ' +
        'Later, when the background subagent finishes on its own, reply AUTO_CONTINUED.'
    )
  );

  const start = Date.now();
  let mainResultAt: number | null = null;
  let sawTopLevelAssistantAfterMainResult = false;
  let sawTaskStarted = false;
  let sawTaskNotification = false;

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
    const t = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[${t}s] ${meta(m)}`);

    const parent = (m as { parent_tool_use_id?: string | null }).parent_tool_use_id;
    const topLevel = parent === null || parent === undefined;
    const sub = (m as { subtype?: string }).subtype;

    if (m.type === 'result' && topLevel && mainResultAt === null) mainResultAt = Date.now();
    if (sub === 'task_started') sawTaskStarted = true;
    if (sub === 'task_notification') sawTaskNotification = true;
    // The smoking gun: a TOP-LEVEL assistant/stream_event AFTER the main turn's
    // result but BEFORE the agent auto-continues => subagent traffic leaking as
    // top-level => turnActive would be wrongly true.
    if (
      mainResultAt !== null &&
      !sawTaskNotification &&
      topLevel &&
      (m.type === 'assistant' || m.type === 'stream_event')
    ) {
      sawTopLevelAssistantAfterMainResult = true;
    }

    if (sawTaskNotification && m.type === 'result' && topLevel && Date.now() - mainResultAt! > 1000)
      break;
  }
  input.close();
  q.close();

  console.log('\n=== SUMMARY ===');
  console.log(`main turn emitted a top-level result: ${mainResultAt !== null}`);
  console.log(`saw task_started: ${sawTaskStarted}, task_notification: ${sawTaskNotification}`);
  console.log(
    `TOP-LEVEL assistant/stream while only the background subagent ran: ${sawTopLevelAssistantAfterMainResult}`
  );
  console.log(
    sawTopLevelAssistantAfterMainResult
      ? '\nBUG CONFIRMED: subagent traffic arrives TOP-LEVEL → turnActive would be stuck true.'
      : '\nNo top-level subagent leak observed (subagent traffic is tagged).'
  );
}

void main();
