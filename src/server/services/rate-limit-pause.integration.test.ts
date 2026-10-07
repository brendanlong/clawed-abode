/**
 * Integration test for the subscription rate-limit pause, driving the real runner
 * with an injected fake SDK query against a real SQLite DB.
 *
 * What it pins down: a rejection parks work instead of failing it, a pause
 * interrupts the live turn, sends during a pause queue rather than reaching the SDK, a session's own policy overrides the
 * global one, the window resetting releases the queue in order, and Stop is the
 * way back out.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { waitFor } from '@/test/wait-for';

const mockSseEvents = vi.hoisted(() => ({
  emitNewMessage: vi.fn(),
  emitClaudeRunning: vi.fn(),
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
      builtinTools: null,
    }),
  };
});

import { createPushable } from '@/lib/pushable';

// Everything that reaches @/lib/prisma is imported dynamically in beforeAll,
// after setupTestDb has pointed DATABASE_URL at the throwaway database. A static
// import instantiates the client against the default path at module load, which
// only works on a machine that happens to have a dev database already.
let runner: typeof import('./claude-runner');
let pause: typeof import('./rate-limit-pause');
let resetRateLimitState: typeof import('./rate-limit-state')._resetRateLimitState;
let resolveSessionHold: typeof import('./rate-limit-state').resolveSessionHold;
let rateLimitState: typeof import('./rate-limit-state');
let GLOBAL_SETTINGS_ID: string;

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);

function makeFakeQuery() {
  const out = createPushable<SDKMessage>();
  const inputs: SDKUserMessage[] = [];
  const cancelAsyncMessage = vi.fn(async (_uuid: string) => true);
  const interrupt = vi.fn(async () => {});

  const factory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: unknown }): Query => {
    void (async () => {
      for await (const m of params.prompt) inputs.push(m);
    })();
    return {
      [Symbol.asyncIterator]: () => out.iterable[Symbol.asyncIterator](),
      interrupt,
      close: vi.fn(() => out.close()),
      supportedCommands: vi.fn(async () => []),
      stopTask: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      setMcpServers: vi.fn(async () => {}),
      cancelAsyncMessage,
    } as unknown as Query;
  };

  return {
    factory,
    emit: (m: SDKMessage) => out.push(m),
    inputs,
    cancelAsyncMessage,
    interrupt,
  };
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

function commandStarted(commandUuid: string): SDKMessage {
  return {
    type: 'command_lifecycle',
    command_uuid: commandUuid,
    state: 'started',
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
  const pushed = fake.inputs.length;
  await runner.sendUserMessage(sessionId, text);
  await waitFor(() => fake.inputs.length > pushed);
  fake.emit(commandStarted(fake.inputs[pushed].uuid!));
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
  await pause.recomputeRateLimitHolds();
}

describe('rate-limit pause', () => {
  beforeAll(async () => {
    await setupTestDb();
    runner = await import('./claude-runner');
    pause = await import('./rate-limit-pause');
    rateLimitState = await import('./rate-limit-state');
    ({ _resetRateLimitState: resetRateLimitState, resolveSessionHold } = rateLimitState);
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
    await pause.initRateLimitPause(runner.rateLimitPauseRunner);
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
    await pause.recomputeRateLimitHolds();

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
    await pause.recomputeRateLimitHolds();

    expect(fake.inputs.map((i) => i.message.content)).toEqual([
      'do the thing',
      pause.RATE_LIMIT_RESUME_PROMPT,
      'and then this',
    ]);
    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } }))
        .resumeAfterRateLimit
    ).toBe(false);

    runner.stopSession(sessionId);
  });

  it('interrupts a live turn at the threshold and resumes it once the window resets', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession({ rateLimitPauseThreshold: 50 });

    await sendAndDeliver(fake, sessionId, 'long job', { settle: false });
    fake.emit(
      rateLimitEvent({
        status: 'allowed',
        rateLimitType: 'five_hour',
        resetsAt: (NOW + HOUR_MS) / 1000,
        unifiedWindows: { five_hour: { utilization: 0.6, resetsAt: (NOW + HOUR_MS) / 1000 } },
      })
    );
    await waitFor(async () => (await testPrisma.rateLimitWindow.count()) > 0);
    await pause.recomputeRateLimitHolds();

    expect(fake.interrupt).toHaveBeenCalledTimes(1);
    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } }))
        .resumeAfterRateLimit
    ).toBe(true);

    // The interrupted turn ends.
    fake.emit({
      type: 'result',
      subtype: 'error_during_execution',
      session_id: 's',
    } as unknown as SDKMessage);
    await waitFor(() => !runner.isClaudeRunning(sessionId));

    // Later recomputes during the same pause find no turn left to interrupt.
    await pause.recomputeRateLimitHolds();
    expect(fake.interrupt).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + HOUR_MS + 1000);
    await pause.recomputeRateLimitHolds();

    expect(fake.inputs.map((i) => i.message.content)).toEqual([
      'long job',
      pause.RATE_LIMIT_RESUME_PROMPT,
    ]);

    runner.stopSession(sessionId);
  });

  it('does not re-arm the resume nudge after the user stops a turn the pause interrupted', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession({ rateLimitPauseThreshold: 50 });

    await sendAndDeliver(fake, sessionId, 'long job', { settle: false });
    fake.emit(
      rateLimitEvent({
        status: 'allowed',
        rateLimitType: 'five_hour',
        resetsAt: (NOW + HOUR_MS) / 1000,
        unifiedWindows: { five_hour: { utilization: 0.6, resetsAt: (NOW + HOUR_MS) / 1000 } },
      })
    );
    await waitFor(async () => (await testPrisma.rateLimitWindow.count()) > 0);
    await pause.recomputeRateLimitHolds();

    // The turn hasn't ended yet, so the user presses Stop; then another reading
    // triggers a recompute before the turn-end arrives.
    await runner.interruptClaude(sessionId);
    await pause.recomputeRateLimitHolds();

    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } }))
        .resumeAfterRateLimit
    ).toBe(false);

    runner.stopSession(sessionId);
  });

  describe('the composer Stop racing a pause (the session stays running)', () => {
    // Drive the pause against a stub runner so the Stop can be placed exactly.
    const rejection = () =>
      rateLimitState.recordRateLimitReadings([
        {
          limitType: 'five_hour',
          rejected: true,
          authoritative: true,
          utilization: 100,
          resetsAtMs: NOW + HOUR_MS,
        },
      ]);
    const resumeFlag = async (sessionId: string) =>
      (await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } }))
        .resumeAfterRateLimit;

    function stubRunner(sessionId: string, abortTurn: runnerPort['abortTurn']): runnerPort {
      return {
        turnActiveSessionIds: () => new Set([sessionId]),
        abortTurn,
        sendUserMessage: vi.fn(async () => {}),
        openQuery: vi.fn(async () => ({ isLive: () => false, push: () => {} })),
        revive: vi.fn(async () => {}),
      };
    }
    type runnerPort = Parameters<typeof pause.initRateLimitPause>[0];

    it('skips the late flag for a rejected turn that had already ended', async () => {
      const sessionId = await createRunningSession();
      let stopped = false;
      await pause.initRateLimitPause(
        stubRunner(sessionId, async (_id, steps) => {
          // The turn ended on its own and the user hit Stop before the pause got here.
          if (!stopped) {
            stopped = true;
            await pause.withdrawQueuedWork(sessionId);
          }
          return { disposed: await steps.dispose([]), interrupted: false, interruptPending: false };
        })
      );

      await rejection();
      await pause.recomputeRateLimitHolds();

      expect(stopped).toBe(true);
      expect(await resumeFlag(sessionId)).toBe(false);
    });

    it('clears a flag the pause wrote just before its interrupt', async () => {
      const sessionId = await createRunningSession();
      let stop: Promise<unknown> | null = null;
      await pause.initRateLimitPause(
        stubRunner(sessionId, async (_id, steps) => {
          const disposed = await steps.dispose([]);
          if (!stop) {
            // Stop lands while the flag write is still in flight.
            const flagging = steps.beforeInterrupt();
            stop = pause.withdrawQueuedWork(sessionId);
            await flagging;
          }
          return { disposed, interrupted: true, interruptPending: true };
        })
      );

      await rejection();
      await pause.recomputeRateLimitHolds();
      await stop;

      expect(await resumeFlag(sessionId)).toBe(false);
    });

    it('revives a session once its hold releases, so other sessions can reach it again', async () => {
      const sessionId = await createRunningSession();
      const stub = stubRunner(sessionId, async (_id, steps) => ({
        disposed: await steps.dispose([]),
        interrupted: false,
        interruptPending: false,
      }));
      await pause.initRateLimitPause(stub);

      await rejection();
      await pause.recomputeRateLimitHolds();
      expect(stub.revive).not.toHaveBeenCalledWith(sessionId);

      vi.setSystemTime(NOW + HOUR_MS + 1000);
      await pause.recomputeRateLimitHolds();
      expect(stub.revive).toHaveBeenCalledWith(sessionId);
    });
  });

  it('does not re-arm the resume nudge when the header Stop lands mid-pause', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();
    const { shutDownSession } = await import('./session-lifecycle');

    await sendAndDeliver(fake, sessionId, 'long job', { settle: false });
    await runner.sendUserMessage(sessionId, 'unread');

    // Hold the pause inside its recall while the user stops the session.
    let releaseCancel!: () => void;
    fake.cancelAsyncMessage.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (releaseCancel = () => resolve(true)))
    );
    const rejection = rejectFiveHourWindow(fake);
    await waitFor(() => fake.cancelAsyncMessage.mock.calls.length > 0);

    await shutDownSession(sessionId);
    releaseCancel();
    await rejection;

    // The rejection landed mid-turn, which would normally earn a nudge — but the
    // user stopped the session, and the next Start must not resume that work.
    const row = await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.status).toBe('stopped');
    expect(row.resumeAfterRateLimit).toBe(false);
  });

  it('lets Stop take back what a pause recalled while the pause is still interrupting', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession({ rateLimitPauseThreshold: 50 });

    await sendAndDeliver(fake, sessionId, 'long job', { settle: false });
    await runner.sendUserMessage(sessionId, 'unread');

    let releaseInterrupt!: () => void;
    fake.interrupt.mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseInterrupt = resolve))
    );
    fake.emit(
      rateLimitEvent({
        status: 'allowed',
        rateLimitType: 'five_hour',
        resetsAt: (NOW + HOUR_MS) / 1000,
        unifiedWindows: { five_hour: { utilization: 0.6, resetsAt: (NOW + HOUR_MS) / 1000 } },
      })
    );
    await waitFor(() => fake.interrupt.mock.calls.length > 0);

    // The recalled prompt is already durable, so Stop finds it.
    const { cancelled } = await runner.interruptClaude(sessionId);
    expect(cancelled).toEqual([{ text: 'unread', attachments: [] }]);

    // Nor does the pause, finishing after the Stop, re-arm the resume nudge.
    releaseInterrupt();
    await pause.recomputeRateLimitHolds();
    expect(
      (await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } }))
        .resumeAfterRateLimit
    ).toBe(false);

    // Once the window resets, nothing the user took back runs.
    vi.setSystemTime(NOW + HOUR_MS + 1000);
    await pause.recomputeRateLimitHolds();
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.inputs.map((i) => i.message.content)).toEqual(['long job', 'unread']);

    runner.stopSession(sessionId);
  });

  it('does not interrupt or nudge an idle session at the threshold', async () => {
    const fake = makeFakeQuery();
    runner._setQueryFactory(fake.factory);
    const sessionId = await createRunningSession({ rateLimitPauseThreshold: 50 });

    await sendAndDeliver(fake, sessionId, 'done already');
    fake.emit(
      rateLimitEvent({
        status: 'allowed',
        rateLimitType: 'five_hour',
        resetsAt: (NOW + HOUR_MS) / 1000,
        unifiedWindows: { five_hour: { utilization: 0.6, resetsAt: (NOW + HOUR_MS) / 1000 } },
      })
    );
    await waitFor(async () => (await testPrisma.rateLimitWindow.count()) > 0);
    await pause.recomputeRateLimitHolds();

    expect(fake.interrupt).not.toHaveBeenCalled();
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
    expect(await resolveSessionHold(urgent)).toBeNull();

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
    await pause.recomputeRateLimitHolds();

    // 60% is past the low-priority session's 50% but short of the global 95%.
    expect(await resolveSessionHold(patient)).toMatchObject({ reason: 'threshold' });
    expect(await resolveSessionHold(eager)).toBeNull();

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
    await pause.recomputeRateLimitHolds();

    expect(await resolveSessionHold(sessionId)).toBeNull();

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
    expect(await resolveSessionHold(sessionId)).toBeNull();

    await pause.initRateLimitPause(runner.rateLimitPauseRunner);

    expect(await resolveSessionHold(sessionId)).toMatchObject({ reason: 'rejected' });
    expect(await queuedTexts(sessionId)).toEqual(['queued']);
  });

  it('skips a stored window of a type it no longer holds for when restoring', async () => {
    const resetsAt = new Date(NOW + HOUR_MS);
    await testPrisma.rateLimitWindow.createMany({
      data: [
        { limitType: 'five_hour', rejected: true, utilization: 100, resetsAt },
        { limitType: 'retired_window', rejected: true, utilization: 100, resetsAt },
      ],
    });

    resetRateLimitState();
    await rateLimitState.loadRateLimitReadings();

    expect(rateLimitState.getRateLimitReadings().map((r) => r.limitType)).toEqual(['five_hour']);
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
    await pause.recomputeRateLimitHolds();
    expect(await resolveSessionHold(sessionId)).toMatchObject({ reason: 'rejected' });

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
    await pause.recomputeRateLimitHolds();

    expect(await resolveSessionHold(sessionId)).toMatchObject({ reason: 'rejected' });
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
    await pause.recomputeRateLimitHolds();

    expect(fake.inputs.at(-1)?.message.content).toBe(pause.RATE_LIMIT_RESUME_PROMPT);
    const after = (await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } }))
      .lastActivityAt;
    expect(after).toEqual(before);

    runner.stopSession(sessionId);
  });
});
