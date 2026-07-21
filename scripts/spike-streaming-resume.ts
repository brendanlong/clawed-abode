/**
 * Throwaway spike for the persistent-streaming-queries refactor
 * (see "Persistent Streaming Query" in doc/claude-sessions.md).
 *
 * De-risks the two UNPROVEN SDK assumptions (plus interrupt as a bonus):
 *
 *   A. Streaming input (AsyncIterable prompt) COMBINED WITH options.resume —
 *      does a resumed session see prior history when driven by streamed input?
 *   B. Background task + auto-continue — when a `run_in_background` task settles,
 *      does its `task_notification` arrive in the same stream while idle AND does
 *      the main agent autonomously start a new turn to act on it (no new user msg)?
 *   C. (bonus) interrupt() — does it emit a terminal `result` and leave the query
 *      usable for another turn?
 *
 * Run (needs working Claude auth — OAuth token or CLAUDE_CODE_OAUTH_TOKEN /
 * ANTHROPIC_API_KEY in the environment):
 *
 *   pnpm tsx scripts/spike-streaming-resume.ts
 *
 * Exits 0 if all three pass, 1 otherwise. Each test prints PASS / FAIL /
 * INCONCLUSIVE with the observed message subtypes for diagnosis.
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

// --- tiny pushable async iterable (same shape the refactor will add) ---------
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

function assistantText(m: SDKMessage): string {
  if (m.type !== 'assistant') return '';
  const content = (m as { message?: { content?: unknown } }).message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
      .map((b) => b.text)
      .join('');
  }
  return '';
}

function subtypeLabel(m: SDKMessage): string {
  const sub = (m as { subtype?: string }).subtype;
  const parent = (m as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  return `${m.type}${sub ? `:${sub}` : ''}${parent ? '(sub)' : ''}`;
}

/**
 * Iterate a query with a hard wall-clock deadline. Returns when the callback
 * signals stop, the stream ends, or the deadline passes (whichever first).
 * Uses a manual iterator so an idle stream can't block past the deadline.
 */
async function drainUntil(
  q: AsyncIterable<SDKMessage>,
  deadlineMs: number,
  onMessage: (m: SDKMessage) => boolean | void
): Promise<'stopped' | 'ended' | 'timeout'> {
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

/**
 * Build options for a session. `cwd` MUST be stable across a resume — Claude Code
 * stores sessions per-project (keyed by cwd), so resuming with a different cwd
 * cannot find the session file. (The real app always reuses the session's
 * workingDir, so this matches production.)
 */
async function newCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'spike-'));
}

function baseOptions(cwd: string): Options {
  return {
    cwd,
    permissionMode: 'bypassPermissions',
    // Use the full Claude Code agent so Bash + run_in_background behave as in the app.
    systemPrompt: { type: 'preset', preset: 'claude_code' },
  };
}

// --- Test A: streaming input + resume ----------------------------------------
async function testResume(): Promise<boolean> {
  console.log('\n=== Test A: streaming input + resume ===');
  const sessionId = randomUUID();
  const secret = 'PURPLE-ELEPHANT-42';
  const seen: string[] = [];
  // Same cwd for both phases so resume can locate the session.
  const cwd = await newCwd();

  // Phase 1 — fresh streaming session, store a secret.
  {
    const input = createPushable<SDKUserMessage>();
    const q = query({ prompt: input.iterable, options: { ...baseOptions(cwd), sessionId } });
    input.push(userMsg(`Remember this secret code: ${secret}. Reply with just the word "stored".`));
    await drainUntil(q, 60_000, (m) => {
      seen.push(subtypeLabel(m));
      if (m.type === 'result') return true;
    });
    input.close();
    q.close();
  }

  // Small gap so the session file is flushed before resume.
  await new Promise((r) => setTimeout(r, 500));

  // Phase 2 — resume that session, also via streaming input, and ask for the secret.
  let answer = '';
  {
    const input = createPushable<SDKUserMessage>();
    const q = query({
      prompt: input.iterable,
      options: { ...baseOptions(cwd), resume: sessionId },
    });
    input.push(userMsg('What was the secret code I told you earlier? Reply with ONLY the code.'));
    const outcome = await drainUntil(q, 60_000, (m) => {
      seen.push(subtypeLabel(m));
      answer += assistantText(m);
      if (m.type === 'result') return true;
    });
    input.close();
    q.close();
    if (outcome === 'timeout') console.log('  (phase 2 timed out)');
  }

  const pass = answer.includes(secret);
  console.log(`  messages: ${seen.join(', ')}`);
  console.log(`  resumed answer contained secret: ${pass}`);
  console.log(
    pass ? '  RESULT: PASS' : '  RESULT: FAIL (resume did not carry history into streamed turn)'
  );
  return pass;
}

// --- Test B: background task + auto-continue ----------------------------------
async function testBackgroundAutoContinue(): Promise<boolean> {
  console.log('\n=== Test B: background task + auto-continue ===');
  const sessionId = randomUUID();
  const input = createPushable<SDKUserMessage>();
  const q = query({
    prompt: input.iterable,
    options: { ...baseOptions(await newCwd()), sessionId },
  });

  const marker = 'BG_TASK_FINISHED';
  input.push(
    userMsg(
      `Run this exact shell command in the BACKGROUND (use the Bash tool with run_in_background set to true): ` +
        `\`sleep 8 && echo ${marker}\`. ` +
        `As soon as you have started it, reply with exactly "STARTED" and then stop — do NOT poll, sleep, ` +
        `or check on it yourself. Later, when the background task finishes ON ITS OWN, reply with ` +
        `"AUTO_CONTINUED" followed by whatever it printed.`
    )
  );

  const seen: string[] = [];
  let sawTaskStarted = false;
  let sawTaskNotification = false;
  let resultCount = 0;
  let autoContinuedText = '';

  // Crucially: we never push another user message. We just keep reading.
  const outcome = await drainUntil(q, 120_000, (m) => {
    seen.push(subtypeLabel(m));
    if (m.type === 'system' && (m as { subtype?: string }).subtype === 'task_started')
      sawTaskStarted = true;
    if (m.type === 'system' && (m as { subtype?: string }).subtype === 'task_notification')
      sawTaskNotification = true;
    if (m.type === 'result') resultCount += 1;
    if (m.type === 'assistant' && resultCount >= 1) {
      // An assistant message AFTER the first turn's result = autonomous continuation.
      const t = assistantText(m);
      if (t.includes('AUTO_CONTINUED') || t.includes(marker)) autoContinuedText = t;
    }
    if (sawTaskNotification && autoContinuedText) return true;
  });
  input.close();
  q.close();

  const pass = sawTaskStarted && sawTaskNotification && !!autoContinuedText;
  console.log(`  messages: ${seen.join(', ')}`);
  console.log(
    `  task_started=${sawTaskStarted} task_notification=${sawTaskNotification} ` +
      `results=${resultCount} autoContinued=${!!autoContinuedText} (outcome=${outcome})`
  );
  if (autoContinuedText)
    console.log(`  continuation text: ${JSON.stringify(autoContinuedText.slice(0, 120))}`);
  if (pass) console.log('  RESULT: PASS');
  else if (sawTaskNotification && !autoContinuedText)
    console.log(
      '  RESULT: INCONCLUSIVE/FAIL — notification arrived but agent did NOT auto-continue ' +
        '(feature value shrinks to "notification surfaced"; design must not assume autonomous follow-up)'
    );
  else if (!sawTaskStarted)
    console.log(
      '  RESULT: INCONCLUSIVE — agent never launched a background task (retry/adjust prompt)'
    );
  else console.log('  RESULT: FAIL');
  return pass;
}

// --- Test C (bonus): interrupt emits a result and query stays usable ----------
async function testInterrupt(): Promise<boolean> {
  console.log('\n=== Test C (bonus): interrupt emits result, query reusable ===');
  const sessionId = randomUUID();
  const input = createPushable<SDKUserMessage>();
  const q = query({
    prompt: input.iterable,
    options: { ...baseOptions(await newCwd()), sessionId },
  });

  input.push(
    userMsg(
      'Count slowly from 1 to 50, using a Bash `sleep 1` between each number. Print each number.'
    )
  );

  const seen: string[] = [];
  let interruptResult = false;
  let interruptFired = false;

  const phase1 = await drainUntil(q, 30_000, (m) => {
    seen.push(subtypeLabel(m));
    // Once it's clearly working, interrupt mid-turn.
    if (!interruptFired && (m.type === 'assistant' || m.type === 'stream_event')) {
      interruptFired = true;
      void q.interrupt();
    }
    if (interruptFired && m.type === 'result') {
      interruptResult = true;
      return true;
    }
  });

  // Now try a fresh turn on the SAME query — proves it stayed alive.
  let secondTurnText = '';
  if (interruptResult) {
    input.push(userMsg('Stop counting. Just reply with exactly "ALIVE".'));
    await drainUntil(q, 30_000, (m) => {
      seen.push(subtypeLabel(m));
      secondTurnText += assistantText(m);
      if (m.type === 'result') return true;
    });
  }
  input.close();
  q.close();

  const pass = interruptResult && secondTurnText.includes('ALIVE');
  console.log(`  messages: ${seen.join(', ')}`);
  console.log(
    `  interrupt produced result=${interruptResult} (phase1=${phase1}); ` +
      `query reusable after interrupt=${secondTurnText.includes('ALIVE')}`
  );
  console.log(
    pass ? '  RESULT: PASS' : '  RESULT: FAIL/INCONCLUSIVE — need a timeout backstop for turnActive'
  );
  return pass;
}

async function main() {
  console.log('Spike: persistent streaming-input session queries');
  console.log(
    'SDK assumptions A (resume+streaming) and B (background auto-continue), plus C (interrupt).'
  );
  const results: Record<string, boolean> = {};
  try {
    results.A_resume = await testResume();
  } catch (e) {
    console.log('  Test A threw:', (e as Error).message);
    results.A_resume = false;
  }
  try {
    results.B_autoContinue = await testBackgroundAutoContinue();
  } catch (e) {
    console.log('  Test B threw:', (e as Error).message);
    results.B_autoContinue = false;
  }
  try {
    results.C_interrupt = await testInterrupt();
  } catch (e) {
    console.log('  Test C threw:', (e as Error).message);
    results.C_interrupt = false;
  }

  console.log('\n=== SUMMARY ===');
  for (const [k, v] of Object.entries(results))
    console.log(`  ${k}: ${v ? 'PASS' : 'FAIL/INCONCLUSIVE'}`);
  const allPass = Object.values(results).every(Boolean);
  console.log(
    allPass
      ? '\nAll passed — assumptions hold, proceed with the build.'
      : '\nSee per-test notes above.'
  );
  process.exit(allPass ? 0 : 1);
}

void main();
