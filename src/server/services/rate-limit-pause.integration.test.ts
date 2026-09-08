/**
 * Integration test for the subscription rate-limit pause, driving the real runner
 * with an injected fake SDK query against a real SQLite DB.
 *
 * What it pins down: a rejection parks work instead of failing it, sends during a
 * pause queue rather than reaching the SDK, a session's own policy overrides the
 * global one, the window resetting releases the queue in order, and Stop is the
 * way back out.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

const mockSseEvents = vi.hoisted(() => ({
  emitNewMessage: vi.fn(),
  emitClaudeRunning: vi.fn(),
  emitClaudeFinished: vi.fn(),
  emitClaudeRetry: vi.fn(),
  emitBackgroundTasks: vi.fn(),
  emitPendingMessages: vi.fn(),
  emitQueuedMessages: vi.fn(),
  emitRateLimitHold: vi.fn(),
  emitMessageRemoved: vi.fn(),
  emitCommands: vi.fn(),
  emitSessionUpdate: vi.fn(),
}));
vi.mock('./events', () => ({ sseEvents: mockSseEvents }));

vi.mock('./uploads', () => ({
  resolveUploadPaths: vi.fn(async (_id: string, names: string[]) => names),
}));
vi.mock('./github', () => ({ fetchPullRequestForBranch: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./worktree-manager', () => ({
  getCurrentBranch: vi.fn().mockResolvedValue(null),
  getSessionWorkingDir: vi.fn(() => '/tmp/rate-limit-pause-test'),
}));
vi.mock('./mcp-config-file', () => ({
  writeSessionMcpConfig: vi.fn(async (sessionId: string) => `/tmp/${sessionId}/mcp.json`),
  removeSessionMcpConfig: vi.fn(async () => {}),
}));
vi.mock('./session-cgroup', () => ({
  getSessionScopeConfig: vi.fn(async () => null),
  sessionScopeNonce: vi.fn(() => 'testnonce'),
  stopSessionScope: vi.fn(async () => {}),
  reapSessionScopes: vi.fn(async () => {}),
}));
vi.mock('./settings-merger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./settings-merger')>();
  return {
    ...actual,
    loadMergedSessionSettings: vi.fn().mockResolvedValue({
      systemPrompt: 'test prompt',
      envVars: [],
      mcpServers: [],
      claudeModel: undefined,
      advisorModel: null,
      claudeApiKey: undefined,
      settingSources: ['project'],
      customSystemPrompt: null,
      globalSettings: {
        systemPromptOverride: null,
        systemPromptOverrideEnabled: false,
        systemPromptAppend: null,
        claudeModel: null,
        advisorModel: null,
        claudeApiKey: null,
        settingSources: { user: false, project: true, local: false },
        envVars: [],
        mcpServers: [],
      },
    }),
  };
});

import { createPushable } from '@/lib/pushable';

// Everything that reaches @/lib/prisma is imported dynamically in beforeAll,
// after setupTestDb has pointed DATABASE_URL at the throwaway database. A static
// import instantiates the client against the default path at module load, which
// only works on a machine that happens to have a dev database already.
type Runner = typeof import('./claude-runner');
let runner: Runner;
let resetRateLimitState: typeof import('./rate-limit-state')._resetRateLimitState;
let GLOBAL_SETTINGS_ID: string;

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);

function makeFakeQuery() {
  const out = createPushable<SDKMessage>();
  const inputs: SDKUserMessage[] = [];
  const cancelAsyncMessage = vi.fn(async (_uuid: string) => true);

  const factory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: unknown }): Query => {
    void (async () => {
      for await (const m of params.prompt) inputs.push(m);
    })();
    return {
      [Symbol.asyncIterator]: () => out.iterable[Symbol.asyncIterator](),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => out.close()),
      supportedCommands: vi.fn(async () => []),
      stopTask: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      setMcpServers: vi.fn(async () => {}),
      cancelAsyncMessage,
    } as unknown as Query;
  };

  return { factory, emit: (m: SDKMessage) => out.push(m), inputs, cancelAsyncMessage };
}

let uuidCounter = 0;
const nextUuid = () => `uuid-${uuidCounter++}`;

/**
 * A `rate_limit_event` shaped like the real ones: `resetsAt` in unix seconds and
 * `utilization` as a 0-1 fraction.
 */
function rateLimitEvent(info: {
  status: string;
  rateLimitType?: string;
  resetsAt?: number;
  utilization?: number;
  unifiedWindows?: Record<string, { utilization: number; resetsAt: number }>;
}): SDKMessage {
  return {
    type: 'rate_limit_event',
    rate_limit_info: info,
    session_id: 's',
    uuid: nextUuid(),
  } as unknown as SDKMessage;
}

function messageStart(): SDKMessage {
  return {
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'message_start' },
    session_id: 's',
    uuid: nextUuid(),
  } as unknown as SDKMessage;
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 2000): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function createRunningSession(
  overrides: {
    rateLimitPauseEnabled?: boolean | null;
    rateLimitPauseThreshold?: number | null;
  } = {}
): Promise<string> {
  const session = await testPrisma.session.create({
    data: { name: 'Test', repoPath: '', status: 'running', ...overrides },
  });
  return session.id;
}

async function setGlobalPause(enabled: boolean, threshold = 95): Promise<void> {
  await testPrisma.globalSettings.upsert({
    where: { id: GLOBAL_SETTINGS_ID },
    create: {
      id: GLOBAL_SETTINGS_ID,
      rateLimitPauseEnabled: enabled,
      rateLimitPauseThreshold: threshold,
    },
    update: { rateLimitPauseEnabled: enabled, rateLimitPauseThreshold: threshold },
  });
}

const queuedTexts = (sessionId: string) =>
  testPrisma.queuedPrompt
    .findMany({ where: { sessionId }, orderBy: { position: 'asc' } })
    .then((rows) => rows.map((r) => r.text));

const userMessageTexts = (sessionId: string) =>
  testPrisma.message
    .findMany({ where: { sessionId, type: 'user' }, orderBy: { sequence: 'asc' } })
    .then((rows) => rows.map((r) => (JSON.parse(r.content) as { content: string }).content));

/**
 * Send a prompt and let the agent visibly pick it up, so it is no longer
 * recallable — the pause only pulls back what the CLI hasn't handed over. Pass
 * `settle: false` to leave the turn generating, the state a rejection cuts short.
 */
async function sendAndDeliver(
  fake: ReturnType<typeof makeFakeQuery>,
  sessionId: string,
  text: string,
  { settle = true } = {}
): Promise<void> {
  await runner.sendUserMessage(sessionId, text);
  fake.emit(messageStart());
  await waitFor(() => runner.getPendingMessageIds(sessionId).length === 0);
  if (!settle) return;
  fake.emit({ type: 'result', subtype: 'success', session_id: 's' } as unknown as SDKMessage);
  await waitFor(() => !runner.isClaudeRunning(sessionId));
}

/** Push a rejection for the 5-hour window through a live session's stream. */
async function rejectFiveHourWindow(fake: ReturnType<typeof makeFakeQuery>): Promise<void> {
  fake.emit(
    rateLimitEvent({
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: (NOW + HOUR_MS) / 1000,
      utilization: 100,
    })
  );
  await waitFor(async () => (await testPrisma.rateLimitWindow.count()) > 0);
  await runner.recomputeRateLimitHolds();
}

describe('rate-limit pause', () => {
  beforeAll(async () => {
    await setupTestDb();
    runner = await import('./claude-runner');
    resetRateLimitState = (await import('./rate-limit-state'))._resetRateLimitState;
    GLOBAL_SETTINGS_ID = (await import('./settings-scope')).GLOBAL_SETTINGS_ID;
  });
  afterAll(async () => {
    await teardownTestDb();
    runner._setQueryFactory(null);
  });
  beforeEach(async () => {
    await clearTestDb();
    vi.clearAllMocks();
    uuidCounter = 0;
    resetRateLimitState();
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await setGlobalPause(true);
    await runner.initRateLimitPause();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues a send instead of reaching the SDK, keeping the bubble', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendAndDeliver(fake, sessionId, 'first');
    await rejectFiveHourWindow(fake);

    await runner.sendUserMessage(sessionId, 'while paused');

    // The prompt never reached the SDK, but the user can still see they sent it.
    expect(fake.inputs.map((i) => i.message.content)).toEqual(['first']);
    expect(await queuedTexts(sessionId)).toEqual(['while paused']);
    expect(await userMessageTexts(sessionId)).toEqual(['first', 'while paused']);
    expect(mockSseEvents.emitQueuedMessages).toHaveBeenCalled();

    runner.stopSession(sessionId);
  });

  it('recalls prompts the CLI had queued but not read, keeping their bubbles', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await runner.sendUserMessage(sessionId, 'unread');
    expect(runner.getPendingMessageIds(sessionId)).toHaveLength(1);

    await rejectFiveHourWindow(fake);

    expect(fake.cancelAsyncMessage).toHaveBeenCalled();
    expect(await queuedTexts(sessionId)).toEqual(['unread']);
    // Unlike Stop, a pause keeps the bubble — the prompt hasn't been abandoned.
    expect(await userMessageTexts(sessionId)).toEqual(['unread']);

    runner.stopSession(sessionId);
  });

  it('releases the queue in order once the window resets', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendAndDeliver(fake, sessionId, 'first');
    await rejectFiveHourWindow(fake);
    await runner.sendUserMessage(sessionId, 'second');
    await runner.sendUserMessage(sessionId, 'third');
    expect(await queuedTexts(sessionId)).toEqual(['second', 'third']);

    vi.setSystemTime(NOW + HOUR_MS + 1000);
    await runner.recomputeRateLimitHolds();

    expect(await queuedTexts(sessionId)).toEqual([]);
    expect(fake.inputs.map((i) => i.message.content)).toEqual(['first', 'second', 'third']);

    runner.stopSession(sessionId);
  });

  it('nudges a session whose turn the rejection cut short, before its queue', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendAndDeliver(fake, sessionId, 'do the thing', { settle: false });
    await rejectFiveHourWindow(fake);
    await runner.sendUserMessage(sessionId, 'and then this');

    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } }))
        .resumeAfterRateLimit
    ).toBe(true);

    vi.setSystemTime(NOW + HOUR_MS + 1000);
    await runner.recomputeRateLimitHolds();

    expect(fake.inputs.map((i) => i.message.content)).toEqual([
      'do the thing',
      runner.RATE_LIMIT_RESUME_PROMPT,
      'and then this',
    ]);
    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } }))
        .resumeAfterRateLimit
    ).toBe(false);

    runner.stopSession(sessionId);
  });

  it('does not nudge a session that was idle when the limit hit', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendAndDeliver(fake, sessionId, 'hello');
    await rejectFiveHourWindow(fake);

    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } }))
        .resumeAfterRateLimit
    ).toBe(false);

    runner.stopSession(sessionId);
  });

  it('leaves a session running when its own policy opts out of pausing', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const paused = await createRunningSession();
    const urgent = await createRunningSession({ rateLimitPauseEnabled: false });

    await sendAndDeliver(fake, paused, 'low priority');
    await rejectFiveHourWindow(fake);

    await runner.sendUserMessage(paused, 'queued');
    await runner.sendUserMessage(urgent, 'must not wait');

    expect(await queuedTexts(paused)).toEqual(['queued']);
    expect(await queuedTexts(urgent)).toEqual([]);
    expect(await runner.getSessionRateLimitHold(urgent)).toBeNull();

    runner.stopSession(paused);
    runner.stopSession(urgent);
  });

  it("pauses at a session's own threshold well before the window is exhausted", async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const eager = await createRunningSession();
    const patient = await createRunningSession({ rateLimitPauseThreshold: 50 });

    await sendAndDeliver(fake, eager, 'start');
    fake.emit(
      rateLimitEvent({
        status: 'allowed',
        rateLimitType: 'five_hour',
        resetsAt: (NOW + HOUR_MS) / 1000,
        // A fraction, as the CLI actually sends it — 0.6 is 60% of the window.
        unifiedWindows: { five_hour: { utilization: 0.6, resetsAt: (NOW + HOUR_MS) / 1000 } },
      })
    );
    await waitFor(async () => (await testPrisma.rateLimitWindow.count()) > 0);
    await runner.recomputeRateLimitHolds();

    // 60% is past the low-priority session's 50% but short of the global 95%.
    expect(await runner.getSessionRateLimitHold(patient)).toMatchObject({ reason: 'threshold' });
    expect(await runner.getSessionRateLimitHold(eager)).toBeNull();

    runner.stopSession(eager);
    runner.stopSession(patient);
  });

  it('never pauses a weekly window on utilization alone', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendAndDeliver(fake, sessionId, 'start');
    fake.emit(
      rateLimitEvent({
        status: 'allowed_warning',
        rateLimitType: 'seven_day',
        resetsAt: (NOW + 7 * 24 * HOUR_MS) / 1000,
        utilization: 0.99,
      })
    );
    await waitFor(async () => (await testPrisma.rateLimitWindow.count()) > 0);
    await runner.recomputeRateLimitHolds();

    expect(await runner.getSessionRateLimitHold(sessionId)).toBeNull();

    runner.stopSession(sessionId);
  });

  it('Stop empties the queue, deletes those bubbles and hands the text back', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendAndDeliver(fake, sessionId, 'first', { settle: false });
    await rejectFiveHourWindow(fake);
    await runner.sendUserMessage(sessionId, 'take this back');

    const { cancelled } = await runner.interruptClaude(sessionId);

    expect(cancelled.map((c) => c.text)).toEqual(['take this back']);
    expect(await queuedTexts(sessionId)).toEqual([]);
    expect(await userMessageTexts(sessionId)).toEqual(['first']);
    // Stopping also withdraws the pending "continue where you left off" nudge.
    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } }))
        .resumeAfterRateLimit
    ).toBe(false);

    runner.stopSession(sessionId);
  });

  it('restores the pause across a restart rather than releasing early', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendAndDeliver(fake, sessionId, 'first');
    await rejectFiveHourWindow(fake);
    await runner.sendUserMessage(sessionId, 'queued');
    runner.stopSession(sessionId);

    // Simulate the process restarting: in-memory readings are gone, the DB isn't.
    resetRateLimitState();
    expect(await runner.getSessionRateLimitHold(sessionId)).toBeNull();

    await runner.initRateLimitPause();

    expect(await runner.getSessionRateLimitHold(sessionId)).toMatchObject({ reason: 'rejected' });
    expect(await queuedTexts(sessionId)).toEqual(['queued']);
  });

  it('keeps a weekly hold when an unrelated 5-hour event reports that window', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();
    const weekReset = (NOW + 3 * 24 * HOUR_MS) / 1000;

    await sendAndDeliver(fake, sessionId, 'start');
    fake.emit(
      rateLimitEvent({
        status: 'rejected',
        rateLimitType: 'seven_day_overage_included',
        resetsAt: weekReset,
        unifiedWindows: {
          seven_day_overage_included: { utilization: 1, resetsAt: weekReset },
        },
      })
    );
    await waitFor(async () => (await testPrisma.rateLimitWindow.count()) > 0);
    await runner.recomputeRateLimitHolds();
    expect(await runner.getSessionRateLimitHold(sessionId)).toMatchObject({ reason: 'rejected' });

    await runner.sendUserMessage(sessionId, 'queued behind the week');

    // A routine 5-hour event carries every window's usage, including the rejected
    // one — but says nothing about refusal, so the hold must survive it.
    fake.emit(
      rateLimitEvent({
        status: 'allowed',
        rateLimitType: 'five_hour',
        resetsAt: (NOW + HOUR_MS) / 1000,
        unifiedWindows: {
          five_hour: { utilization: 0.4, resetsAt: (NOW + HOUR_MS) / 1000 },
          seven_day_overage_included: { utilization: 1, resetsAt: weekReset },
        },
      })
    );
    await waitFor(async () => (await testPrisma.rateLimitWindow.count()) > 1);
    await runner.recomputeRateLimitHolds();

    expect(await runner.getSessionRateLimitHold(sessionId)).toMatchObject({ reason: 'rejected' });
    expect(await queuedTexts(sessionId)).toEqual(['queued behind the week']);

    runner.stopSession(sessionId);
  });

  it('does not leave the composer working after recalling a never-read prompt', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    // A send the CLI never picks up: turnActive is only optimistic, so nothing
    // will ever arrive to clear it once the pause pulls the prompt back.
    await runner.sendUserMessage(sessionId, 'never read');
    expect(runner.isClaudeRunning(sessionId)).toBe(true);

    await rejectFiveHourWindow(fake);

    expect(runner.isClaudeRunning(sessionId)).toBe(false);
    expect(await queuedTexts(sessionId)).toEqual(['never read']);
    // ...and it must not be mistaken for a cut-short turn needing a nudge.
    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } }))
        .resumeAfterRateLimit
    ).toBe(false);

    runner.stopSession(sessionId);
  });

  it('does not reorder the session list when the resume nudge fires', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendAndDeliver(fake, sessionId, 'do the thing', { settle: false });
    await rejectFiveHourWindow(fake);
    const before = (await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } }))
      .lastActivityAt;

    vi.setSystemTime(NOW + HOUR_MS + 1000);
    await runner.recomputeRateLimitHolds();

    expect(fake.inputs.at(-1)?.message.content).toBe(runner.RATE_LIMIT_RESUME_PROMPT);
    const after = (await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } }))
      .lastActivityAt;
    expect(after).toEqual(before);

    runner.stopSession(sessionId);
  });
});
