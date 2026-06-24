/**
 * Throwaway end-to-end verification of the REAL runner against the REAL SDK.
 * Not a committed test — exercises sendUserMessage/runSessionLoop/interrupt with a
 * temp SQLite DB and a real Claude query. Run with CLAUDE_CODE_OAUTH_TOKEN set.
 */
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

const dbDir = mkdtempSync(join(tmpdir(), 'e2e-db-'));
process.env.DATABASE_URL = `file:${join(dbDir, 't.db')}`;
process.env.ENCRYPTION_KEY ||= 'x'.repeat(32);
execSync('npx prisma migrate deploy', { env: process.env, stdio: 'pipe' });

type Prisma = typeof import('../src/lib/prisma').prisma;
type Runner = typeof import('../src/server/services/claude-runner');
type SseEvents = typeof import('../src/server/services/events').sseEvents;
let prisma: Prisma;
let runner: Runner;
let sseEvents: SseEvents;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean | Promise<boolean>, ms = 90_000, label = '') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(`waitFor timed out: ${label}`);
}
const msgs = (id: string) =>
  prisma.message.findMany({ where: { sessionId: id }, orderBy: { sequence: 'asc' } });

async function setup(): Promise<{ id: string; events: string[]; cleanup: () => void }> {
  const session = await prisma.session.create({
    data: { name: 'e2e', workspacePath: '', repoPath: '', status: 'running' },
  });
  const wd = join(homedir(), 'worktrees', session.id);
  mkdirSync(wd, { recursive: true });
  const events: string[] = [];
  const unsub = sseEvents.onSessionEvents(session.id, (e) => {
    if (e.kind === 'running') events.push(`running=${e.running}`);
    if (e.kind === 'background') events.push(`bg=${e.tasks.length}`);
  });
  return {
    id: session.id,
    events,
    cleanup: () => {
      unsub();
      rmSync(wd, { recursive: true, force: true });
    },
  };
}

let pass = 0;
let fail = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`);
  if (cond) pass++;
  else fail++;
};

async function testBasicTurn() {
  console.log('\n=== E2E 1: basic turn persists + toggles running ===');
  const { id, events, cleanup } = await setup();
  await runner.sendUserMessage(id, 'Reply with exactly the word READY and nothing else.');
  check(runner.isClaudeRunning(id), 'turnActive true immediately after send');
  await waitFor(() => !runner.isClaudeRunning(id), 90_000, 'turn end');
  const m = await msgs(id);
  const types = m.map((x) => x.type);
  check(types[0] === 'user', 'first message is user');
  check(types.includes('assistant'), 'has an assistant message');
  check(types.includes('result'), 'has a result message');
  check(
    events.includes('running=true') && events.includes('running=false'),
    'emitted running true then false'
  );
  runner.stopSession(id);
  cleanup();
}

async function testBackgroundSurvivesTurn() {
  console.log('\n=== E2E 2: background task survives turn end + auto-continue ===');
  const { id, events, cleanup } = await setup();
  await runner.sendUserMessage(
    id,
    'Use the Bash tool with run_in_background=true to run exactly: `sleep 6 && echo BG_DONE`. ' +
      'Then reply with exactly STARTED and stop — do not poll. When it finishes on its own, reply AUTO_CONTINUED.'
  );
  // Background task should appear, and the main turn should end while it runs.
  await waitFor(() => runner.getSessionBackgroundTasks(id).length > 0, 60_000, 'task_started');
  check(true, 'background task registered');
  await waitFor(() => !runner.isClaudeRunning(id), 60_000, 'main turn ends while bg runs');
  check(
    runner.getSessionBackgroundTasks(id).length > 0,
    'background task still running AFTER the main turn ended (composer would be free)'
  );
  // It settles and the agent autonomously continues.
  await waitFor(
    () => runner.getSessionBackgroundTasks(id).length === 0,
    60_000,
    'task_notification'
  );
  check(true, 'background task cleared after notification');
  await waitFor(
    async () => {
      const text = (await msgs(id))
        .filter((x) => x.type === 'assistant')
        .map((x) => x.content)
        .join(' ');
      return text.includes('AUTO_CONTINUED') || text.includes('BG_DONE');
    },
    30_000,
    'autonomous continuation'
  );
  check(true, 'agent autonomously continued after the background task finished');
  console.log(`  events: ${events.join(', ')}`);
  runner.stopSession(id);
  cleanup();
}

async function testBackgroundSubagentFreesComposer() {
  console.log('\n=== E2E 2b: run_in_background SUBAGENT frees the composer while it runs ===');
  const { id, events, cleanup } = await setup();
  await runner.sendUserMessage(
    id,
    'Use the Agent tool (a.k.a. Task) with run_in_background set to true and subagent_type ' +
      '"general-purpose" to launch a subagent whose ONLY job is to run `sleep 10` then reply DONE. ' +
      'As soon as it is launched, reply with exactly STARTED and stop — do NOT wait or poll. ' +
      'When the subagent finishes on its own, reply AUTO_CONTINUED.'
  );
  await waitFor(
    () => runner.getSessionBackgroundTasks(id).length > 0,
    60_000,
    'subagent task_started'
  );
  check(true, 'background subagent registered');
  // THE REGRESSION: the SDK keeps the parent turn open for a background subagent
  // (defers the result), but the main agent's end_turn must free turnActive while
  // the subagent is still running.
  await waitFor(() => !runner.isClaudeRunning(id), 30_000, 'composer freed while subagent runs');
  check(
    !runner.isClaudeRunning(id) && runner.getSessionBackgroundTasks(id).length > 0,
    'turnActive is FALSE while the background subagent is still running (composer free)'
  );
  await waitFor(
    () => runner.getSessionBackgroundTasks(id).length === 0,
    60_000,
    'subagent settled'
  );
  check(true, 'background subagent cleared after notification');
  console.log(`  events: ${events.join(', ')}`);
  runner.stopSession(id);
  cleanup();
}

async function testInterrupt() {
  console.log('\n=== E2E 3: interrupt ends the turn, query reusable ===');
  const { id, cleanup } = await setup();
  await runner.sendUserMessage(
    id,
    'Count slowly from 1 to 40, using a Bash `sleep 1` between each. Print each number.'
  );
  await waitFor(() => runner.isClaudeRunning(id), 30_000, 'turn started');
  await sleep(3000);
  const interrupted = await runner.interruptClaude(id);
  check(interrupted, 'interrupt returned true');
  await waitFor(() => !runner.isClaudeRunning(id), 30_000, 'turnActive cleared after interrupt');
  check(!runner.isClaudeRunning(id), 'turnActive false after interrupt');
  // Query reusable: a new turn on the same session. Wait for the continuation
  // itself (not the running flag) — a late stray result from the interrupted turn
  // can briefly clear turnActive while turn 2 is still starting.
  await runner.sendUserMessage(id, 'Stop counting. Reply with exactly ALIVE.');
  await waitFor(
    async () => (await msgs(id)).some((x) => x.type === 'assistant' && x.content.includes('ALIVE')),
    60_000,
    'continuation produced ALIVE'
  );
  check(true, 'query was reusable after interrupt (got ALIVE)');
  runner.stopSession(id);
  cleanup();
}

async function main() {
  prisma = (await import('../src/lib/prisma')).prisma;
  runner = await import('../src/server/services/claude-runner');
  sseEvents = (await import('../src/server/services/events')).sseEvents;

  // One global (non-secret) env var gives every session's agent the token.
  await prisma.envVar.create({
    data: {
      name: 'CLAUDE_CODE_OAUTH_TOKEN',
      value: process.env.CLAUDE_CODE_OAUTH_TOKEN!,
      isSecret: false,
    },
  });

  try {
    await testBasicTurn();
    await testBackgroundSurvivesTurn();
    await testBackgroundSubagentFreesComposer();
    await testInterrupt();
  } catch (e) {
    console.error('THREW:', (e as Error).message);
    fail++;
  } finally {
    await runner.stopAllSessions();
    await prisma.$disconnect();
    rmSync(dbDir, { recursive: true, force: true });
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
