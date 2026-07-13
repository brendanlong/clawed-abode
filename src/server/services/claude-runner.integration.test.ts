/**
 * Integration test for the persistent streaming-query runner.
 *
 * Drives runSessionLoop with an INJECTED fake SDK query (no real SDK/auth) against
 * a real in-memory SQLite DB, exercising the behaviors that matter for the
 * refactor: multi-turn over one persistent query, background tasks surviving a
 * turn, two-axis status emission, sequence integrity, and clean teardown.
 *
 * Real-SDK behavior (resume+streaming, interrupt, background auto-continue) is
 * covered by scripts/spike-streaming-resume.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

const mockSseEvents = vi.hoisted(() => ({
  emitNewMessage: vi.fn(),
  emitClaudeRunning: vi.fn(),
  emitClaudeFinished: vi.fn(),
  emitClaudeRetry: vi.fn(),
  emitBackgroundTasks: vi.fn(),
  emitQueuedMessages: vi.fn(),
  emitCommands: vi.fn(),
  emitSessionUpdate: vi.fn(),
  emitPrUpdate: vi.fn(),
}));
vi.mock('./events', () => ({ sseEvents: mockSseEvents }));

// Uploads: resolve stored names to paths. Default passthrough; a test overrides it
// to reject, to exercise the non-destructive flush/idle-send error paths.
const mockResolveUploadPaths = vi.hoisted(() =>
  vi.fn(async (_id: string, names: string[]) => names)
);
vi.mock('./uploads', () => ({ resolveUploadPaths: mockResolveUploadPaths }));

vi.mock('./github', () => ({
  fetchPullRequestForBranch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./worktree-manager', () => ({
  getCurrentBranch: vi.fn().mockResolvedValue(null),
  getSessionWorkingDir: vi.fn(() => '/tmp/spike-runner-test'),
}));

const baseSettings = {
  systemPrompt: 'test prompt',
  envVars: [],
  mcpServers: [],
  claudeModel: undefined as string | undefined,
  advisorModel: null as string | null,
  claudeApiKey: undefined,
  settingSources: ['project'] as ('user' | 'project' | 'local')[],
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
};

// Keep the real mcpServersEqual (applyLiveSettings uses it); only stub the loader.
vi.mock('./settings-merger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./settings-merger')>();
  return {
    ...actual,
    loadMergedSessionSettings: vi.fn().mockResolvedValue({ ...baseSettings }),
  };
});

import { createPushable } from '@/lib/pushable';

// Imported dynamically in beforeAll (after setupTestDb sets DATABASE_URL), since
// claude-runner pulls in @/lib/prisma at module load.
let sendUserMessage: typeof import('./claude-runner').sendUserMessage;
let cancelQueuedMessage: typeof import('./claude-runner').cancelQueuedMessage;
let getQueuedMessages: typeof import('./claude-runner').getQueuedMessages;
let interruptClaude: typeof import('./claude-runner').interruptClaude;
let stopSession: typeof import('./claude-runner').stopSession;
let isClaudeRunning: typeof import('./claude-runner').isClaudeRunning;
let getSessionBackgroundTasks: typeof import('./claude-runner').getSessionBackgroundTasks;
let stopBackgroundTask: typeof import('./claude-runner').stopBackgroundTask;
let insertMessage: typeof import('./claude-runner').insertMessage;
let _setQueryFactory: typeof import('./claude-runner')._setQueryFactory;
let mockLoadSettings: ReturnType<
  typeof vi.mocked<typeof import('./settings-merger').loadMergedSessionSettings>
>;

// --- fake SDK query ----------------------------------------------------------
function makeFakeQuery() {
  const out = createPushable<SDKMessage>();
  const inputs: SDKUserMessage[] = [];
  const setModel = vi.fn(async () => {});
  const setMcpServers = vi.fn(async () => {});
  const stopTask = vi.fn(async (_taskId: string) => {});

  const factory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: unknown }): Query => {
    // Record pushed user messages so we can assert sendUserMessage reached the SDK.
    void (async () => {
      for await (const m of params.prompt) inputs.push(m);
    })();
    return {
      [Symbol.asyncIterator]: () => out.iterable[Symbol.asyncIterator](),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => out.close()),
      supportedCommands: vi.fn(async () => []),
      stopTask,
      setModel,
      setMcpServers,
    } as unknown as Query;
  };

  return {
    factory,
    emit: (m: SDKMessage) => out.push(m),
    end: () => out.close(),
    inputs,
    setModel,
    setMcpServers,
    stopTask,
  };
}

// --- message builders --------------------------------------------------------
let uuidCounter = 0;
const nextUuid = () => `uuid-${uuidCounter++}`;

// A zero-width space (invisible), built from a code point so no hidden byte lives
// in this source file. Used to exercise the tool-output sanitizer end to end.
const ZWSP = String.fromCharCode(0x200b);

function toolResultMsg(toolUseId: string, text: string): SDKMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }],
    },
    session_id: 's',
    uuid: nextUuid(),
  } as unknown as SDKMessage;
}

/** The PostToolUse hook the runner wired into the SDK options (real fn). */
type PostToolUseHook = (input: unknown) => Promise<unknown>;
function extractPostToolUseHook(options: unknown): PostToolUseHook {
  const hooks = (options as { hooks?: { PostToolUse?: Array<{ hooks: PostToolUseHook[] }> } }).hooks
    ?.PostToolUse;
  const hook = hooks?.[0]?.hooks?.[0];
  if (!hook) throw new Error('PostToolUse hook not wired into options');
  return hook;
}

function assistant(text: string, parent: string | null = null): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    session_id: 's',
    uuid: nextUuid(),
  } as unknown as SDKMessage;
}
function result(subtype = 'success'): SDKMessage {
  return { type: 'result', subtype, session_id: 's', uuid: nextUuid() } as unknown as SDKMessage;
}
function messageStart(parent: string | null = null): SDKMessage {
  return {
    type: 'stream_event',
    parent_tool_use_id: parent,
    event: { type: 'message_start' },
    session_id: 's',
    uuid: nextUuid(),
  } as unknown as SDKMessage;
}
function messageDelta(stopReason: string | null, parent: string | null = null): SDKMessage {
  return {
    type: 'stream_event',
    parent_tool_use_id: parent,
    event: { type: 'message_delta', delta: { stop_reason: stopReason } },
    session_id: 's',
    uuid: nextUuid(),
  } as unknown as SDKMessage;
}
function taskStarted(taskId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    description: 'background work',
    session_id: 's',
    uuid: nextUuid(),
  } as unknown as SDKMessage;
}
function taskNotification(taskId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status: 'completed',
    output_file: '/tmp/o',
    summary: 'done',
    session_id: 's',
    uuid: nextUuid(),
  } as unknown as SDKMessage;
}
function taskUpdated(taskId: string, status: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: taskId,
    patch: { status },
    session_id: 's',
    uuid: nextUuid(),
  } as unknown as SDKMessage;
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 2000): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function createRunningSession(): Promise<string> {
  const session = await testPrisma.session.create({
    data: { name: 'Test', workspacePath: '/tmp/ws', repoPath: '', status: 'running' },
  });
  return session.id;
}

function messagesFor(sessionId: string) {
  return testPrisma.message.findMany({ where: { sessionId }, orderBy: { sequence: 'asc' } });
}

describe('claude-runner persistent streaming loop', () => {
  beforeAll(async () => {
    await setupTestDb();
    const mod = await import('./claude-runner');
    sendUserMessage = mod.sendUserMessage;
    cancelQueuedMessage = mod.cancelQueuedMessage;
    getQueuedMessages = mod.getQueuedMessages;
    interruptClaude = mod.interruptClaude;
    stopSession = mod.stopSession;
    isClaudeRunning = mod.isClaudeRunning;
    getSessionBackgroundTasks = mod.getSessionBackgroundTasks;
    stopBackgroundTask = mod.stopBackgroundTask;
    insertMessage = mod.insertMessage;
    _setQueryFactory = mod._setQueryFactory;
    const sm = await import('./settings-merger');
    mockLoadSettings = vi.mocked(sm.loadMergedSessionSettings);
  });
  afterAll(async () => {
    await teardownTestDb();
    _setQueryFactory(null);
  });
  beforeEach(async () => {
    await clearTestDb();
    vi.clearAllMocks();
    uuidCounter = 0;
    mockLoadSettings.mockResolvedValue({ ...baseSettings });
  });

  it('persists a turn and toggles turnActive on/off', async () => {
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'hello');
    expect(isClaudeRunning(sessionId)).toBe(true); // optimistic

    fake.emit(assistant('hi there'));
    fake.emit(result());

    await waitFor(async () => (await messagesFor(sessionId)).length >= 3);
    const msgs = await messagesFor(sessionId);
    expect(msgs.map((m) => m.type)).toEqual(['user', 'assistant', 'result']);
    expect(msgs.map((m) => m.sequence)).toEqual([0, 1, 2]);

    // The user prompt reached the SDK input stream.
    expect(fake.inputs).toHaveLength(1);
    expect(fake.inputs[0].message.content).toBe('hello');

    await waitFor(() => !isClaudeRunning(sessionId));
    expect(mockSseEvents.emitClaudeRunning).toHaveBeenCalledWith(sessionId, true);
    expect(mockSseEvents.emitClaudeRunning).toHaveBeenCalledWith(sessionId, false);
    // A natural turn end signals work-complete (drives the app-level notifier).
    expect(mockSseEvents.emitClaudeFinished).toHaveBeenCalledWith(sessionId);

    stopSession(sessionId);
  });

  it('bumps lastActivityAt on user sends but not on assistant traffic', async () => {
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();
    const past = new Date('2020-01-01T00:00:00Z');
    await testPrisma.session.update({
      where: { id: sessionId },
      data: { lastActivityAt: past },
    });

    // Sending a prompt is a user interaction — it bumps (awaited before return).
    await sendUserMessage(sessionId, 'hello');
    const afterSend = await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(afterSend.lastActivityAt.getTime()).toBeGreaterThan(past.getTime());

    // Assistant/result persistence must NOT bump, so sessions working in the
    // background don't reorder the list. Pin a sentinel and let the turn finish.
    const sentinel = new Date('2021-01-01T00:00:00Z');
    await testPrisma.session.update({
      where: { id: sessionId },
      data: { lastActivityAt: sentinel },
    });
    fake.emit(assistant('hi there'));
    fake.emit(result());
    await waitFor(async () => (await messagesFor(sessionId)).length >= 3);

    const afterTurn = await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(afterTurn.lastActivityAt.getTime()).toBe(sentinel.getTime());

    stopSession(sessionId);
  });

  it('keeps the query alive across turns and survives a background task past turn end', async () => {
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    // Turn 1
    await sendUserMessage(sessionId, 'start a background job');
    fake.emit(assistant('starting'));
    fake.emit(taskStarted('task-1'));
    fake.emit(result()); // main turn ends, but the query stays alive

    await waitFor(() => !isClaudeRunning(sessionId));
    // turnActive is false, but the background task is still tracked.
    expect(getSessionBackgroundTasks(sessionId).map((t) => t.taskId)).toEqual(['task-1']);
    expect(mockSseEvents.emitBackgroundTasks).toHaveBeenCalledWith(sessionId, [
      expect.objectContaining({ taskId: 'task-1', description: 'background work' }),
    ]);

    // The background task settles later, and the agent autonomously continues.
    fake.emit(taskNotification('task-1'));
    fake.emit(assistant('background job done'));
    fake.emit(result());

    await waitFor(() => getSessionBackgroundTasks(sessionId).length === 0);
    await waitFor(async () => {
      const types = (await messagesFor(sessionId)).map((m) => m.type);
      // user, assistant, task_started(system), result, task_notification(system), assistant, result
      return types.filter((t) => t === 'assistant').length === 2;
    });

    const msgs = await messagesFor(sessionId);
    // sequences are contiguous and ordered across both turns + background messages.
    expect(msgs.map((m) => m.sequence)).toEqual([...Array(msgs.length).keys()]);

    stopSession(sessionId);
  });

  it('settles a background task via a terminal task_updated (no task_notification)', async () => {
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'start a background job');
    fake.emit(taskStarted('task-1'));
    fake.emit(result());
    await waitFor(() => getSessionBackgroundTasks(sessionId).length === 1);
    mockSseEvents.emitBackgroundTasks.mockClear();

    // The task ends via task_updated(killed) with NO terminal task_notification.
    fake.emit(taskUpdated('task-1', 'killed'));

    await waitFor(() => getSessionBackgroundTasks(sessionId).length === 0);
    expect(mockSseEvents.emitBackgroundTasks).toHaveBeenCalledWith(sessionId, []);

    stopSession(sessionId);
  });

  it('stopBackgroundTask clears a tracked task, emits [], and calls the SDK', async () => {
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'start a background job');
    fake.emit(taskStarted('task-1'));
    fake.emit(result());
    await waitFor(() => getSessionBackgroundTasks(sessionId).length === 1);
    mockSseEvents.emitBackgroundTasks.mockClear();

    const removed = await stopBackgroundTask(sessionId, 'task-1');

    expect(removed).toBe(true);
    expect(fake.stopTask).toHaveBeenCalledWith('task-1');
    expect(getSessionBackgroundTasks(sessionId)).toEqual([]);
    expect(mockSseEvents.emitBackgroundTasks).toHaveBeenCalledWith(sessionId, []);

    stopSession(sessionId);
  });

  it('stopBackgroundTask clears the indicator even when stopTask rejects (phantom)', async () => {
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'start a background job');
    fake.emit(taskStarted('task-1'));
    fake.emit(result());
    await waitFor(() => getSessionBackgroundTasks(sessionId).length === 1);

    // Simulate a phantom: the SDK no longer knows the task, so stopTask throws.
    fake.stopTask.mockRejectedValueOnce(new Error('no such task'));

    const removed = await stopBackgroundTask(sessionId, 'task-1');

    expect(removed).toBe(true);
    expect(getSessionBackgroundTasks(sessionId)).toEqual([]);
    expect(mockSseEvents.emitBackgroundTasks).toHaveBeenCalledWith(sessionId, []);

    stopSession(sessionId);
  });

  it('a late terminal notification after optimistic removal is a no-op (no extra emit)', async () => {
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'start a background job');
    fake.emit(taskStarted('task-1'));
    fake.emit(result());
    await waitFor(() => getSessionBackgroundTasks(sessionId).length === 1);

    await stopBackgroundTask(sessionId, 'task-1');
    await waitFor(() => !isClaudeRunning(sessionId));
    mockSseEvents.emitBackgroundTasks.mockClear();

    // The real terminal notification arrives late; the reducer sees the task is
    // already gone and must not re-emit the background channel.
    fake.emit(taskNotification('task-1'));
    // Drive a turn so we can deterministically wait for the message to be processed.
    fake.emit(assistant('done'));
    fake.emit(result());
    await waitFor(async () =>
      (await messagesFor(sessionId)).some(
        (m) => m.type === 'assistant' && m.content.includes('done')
      )
    );

    expect(getSessionBackgroundTasks(sessionId)).toEqual([]);
    expect(mockSseEvents.emitBackgroundTasks).not.toHaveBeenCalled();

    stopSession(sessionId);
  });

  it('is idempotent: a second stop of the same task returns true with no extra emit', async () => {
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'start a background job');
    fake.emit(taskStarted('task-1'));
    fake.emit(result());
    await waitFor(() => getSessionBackgroundTasks(sessionId).length === 1);

    // First stop removes the entry and emits [].
    expect(await stopBackgroundTask(sessionId, 'task-1')).toBe(true);
    expect(getSessionBackgroundTasks(sessionId)).toEqual([]);
    mockSseEvents.emitBackgroundTasks.mockClear();

    // Second stop (task already gone) still reports success, but emits nothing.
    expect(await stopBackgroundTask(sessionId, 'task-1')).toBe(true);
    expect(mockSseEvents.emitBackgroundTasks).not.toHaveBeenCalled();

    stopSession(sessionId);
  });

  it('returns true for an untracked id on a live session, false when no session exists', async () => {
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'hi');
    fake.emit(result());
    await waitFor(() => !isClaudeRunning(sessionId));

    // Live session, task never tracked → post-condition already holds → true.
    expect(await stopBackgroundTask(sessionId, 'ghost')).toBe(true);
    // No live session state to act on → false.
    expect(await stopBackgroundTask('00000000-0000-0000-0000-000000000000', 'task-1')).toBe(false);

    stopSession(sessionId);
  });

  it('stopSession closes the query and removes the session', async () => {
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'hi');
    fake.emit(assistant('ok'));
    fake.emit(result());
    await waitFor(() => !isClaudeRunning(sessionId));

    stopSession(sessionId);
    expect(isClaudeRunning(sessionId)).toBe(false);
    // A second sendUserMessage would re-establish a fresh query (lazy revive).
    expect(getSessionBackgroundTasks(sessionId)).toEqual([]);
  });

  it('injects the advisor model into extraArgs.settings when one is set', async () => {
    const fake = makeFakeQuery();
    let options: { extraArgs?: Record<string, string> } | undefined;
    _setQueryFactory((p) => {
      options = p.options as { extraArgs?: Record<string, string> };
      return fake.factory(p);
    });
    mockLoadSettings.mockResolvedValue({ ...baseSettings, advisorModel: 'claude-opus-4-8' });
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'hello');
    expect(options?.extraArgs?.settings).toBe(JSON.stringify({ advisorModel: 'claude-opus-4-8' }));

    fake.emit(result());
    await waitFor(() => !isClaudeRunning(sessionId));
    stopSession(sessionId);
  });

  it('passes the resolved settingSources through to the SDK query', async () => {
    const fake = makeFakeQuery();
    let options: { settingSources?: string[] } | undefined;
    _setQueryFactory((p) => {
      options = p.options as { settingSources?: string[] };
      return fake.factory(p);
    });
    mockLoadSettings.mockResolvedValue({
      ...baseSettings,
      settingSources: ['user', 'project'],
    });
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'hello');
    expect(options?.settingSources).toEqual(['user', 'project']);

    fake.emit(result());
    await waitFor(() => !isClaudeRunning(sessionId));
    stopSession(sessionId);
  });

  it('omits the settings arg entirely when the advisor is disabled', async () => {
    const fake = makeFakeQuery();
    let options: { extraArgs?: Record<string, string> } | undefined;
    _setQueryFactory((p) => {
      options = p.options as { extraArgs?: Record<string, string> };
      return fake.factory(p);
    });
    // baseSettings has advisorModel: null (the disabled default).
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'hello');
    expect(options?.extraArgs?.settings).toBeUndefined();

    fake.emit(result());
    await waitFor(() => !isClaudeRunning(sessionId));
    stopSession(sessionId);
  });

  it('queues messages sent during a turn (unpersisted, surfaced) and flushes them at turn end', async () => {
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    // Turn 1 starts and pushes immediately (the fake reads input asynchronously).
    await sendUserMessage(sessionId, 'first');
    expect(isClaudeRunning(sessionId)).toBe(true);
    await waitFor(() => fake.inputs.length >= 1);

    // Two more sends while the turn is active are queued, not pushed — and unlike
    // before, NOT persisted: only the first message is in the transcript so far.
    await sendUserMessage(sessionId, 'second');
    await sendUserMessage(sessionId, 'third');
    expect(getQueuedMessages(sessionId).map((m) => m.text)).toEqual(['second', 'third']);
    expect(mockSseEvents.emitQueuedMessages).toHaveBeenCalled();
    const duringTurn = await messagesFor(sessionId);
    expect(duringTurn).toHaveLength(1);
    // Still only the first prompt reached the SDK; the rest are queued.
    expect(fake.inputs).toHaveLength(1);

    // The turn ends → queued messages persist (as their own bubbles) and flush
    // together as one combined push.
    fake.emit(result());
    await waitFor(() => fake.inputs.length >= 2);
    expect(fake.inputs[1].message.content).toBe('second\n\nthird');
    await waitFor(
      async () => (await messagesFor(sessionId)).filter((m) => m.type === 'user').length >= 3
    );
    const userMsgs = (await messagesFor(sessionId)).filter((m) => m.type === 'user');
    expect(userMsgs).toHaveLength(3);
    // The queue is emptied and the empty list emitted.
    expect(getQueuedMessages(sessionId)).toHaveLength(0);
    expect(mockSseEvents.emitQueuedMessages).toHaveBeenCalledWith(sessionId, []);

    // turnActive stays continuously true across the handoff (no idle blip that
    // would trip work-complete notifications / voice auto-read between turns).
    expect(isClaudeRunning(sessionId)).toBe(true);
    expect(mockSseEvents.emitClaudeRunning).not.toHaveBeenCalledWith(sessionId, false);

    stopSession(sessionId);
  });

  it('leaves queued messages queued on interrupt (does not flush them as a new turn)', async () => {
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'first');
    fake.emit(messageStart());
    await waitFor(() => isClaudeRunning(sessionId));

    // Queue a message mid-turn, then Stop.
    await sendUserMessage(sessionId, 'queued while working');
    expect(getQueuedMessages(sessionId).map((m) => m.text)).toEqual(['queued while working']);

    mockSseEvents.emitClaudeFinished.mockClear();
    expect(await interruptClaude(sessionId)).toBe(true);
    // The interrupt's terminal result ends the turn WITHOUT flushing the queue.
    fake.emit(result('error_during_execution'));
    await waitFor(() => !isClaudeRunning(sessionId));

    // An interrupt is NOT a natural completion — no work-complete signal fires.
    expect(mockSseEvents.emitClaudeFinished).not.toHaveBeenCalled();

    // The queued message is still queued (never pushed to the SDK, never persisted).
    expect(fake.inputs).toHaveLength(1);
    expect(getQueuedMessages(sessionId).map((m) => m.text)).toEqual(['queued while working']);
    expect((await messagesFor(sessionId)).filter((m) => m.type === 'user')).toHaveLength(1);

    stopSession(sessionId);
  });

  it('cancelQueuedMessage removes a queued message and emits the update', async () => {
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'first');
    fake.emit(messageStart());
    await waitFor(() => isClaudeRunning(sessionId));
    await sendUserMessage(sessionId, 'remove me');

    const [queued] = getQueuedMessages(sessionId);
    expect(queued.text).toBe('remove me');

    expect(cancelQueuedMessage(sessionId, queued.id)).toBe(true);
    expect(getQueuedMessages(sessionId)).toHaveLength(0);
    expect(mockSseEvents.emitQueuedMessages).toHaveBeenLastCalledWith(sessionId, []);

    // Removing an absent id is an idempotent no-op that still reports success.
    expect(cancelQueuedMessage(sessionId, 'nope')).toBe(true);

    stopSession(sessionId);
  });

  it('flushes leftover queued messages ahead of an idle send, combined in order', async () => {
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    // Queue a message mid-turn, then interrupt so it's left sitting (idle).
    await sendUserMessage(sessionId, 'first');
    fake.emit(messageStart());
    await waitFor(() => isClaudeRunning(sessionId));
    await sendUserMessage(sessionId, 'leftover');
    await interruptClaude(sessionId);
    fake.emit(result('error_during_execution'));
    await waitFor(() => !isClaudeRunning(sessionId));
    expect(getQueuedMessages(sessionId).map((m) => m.text)).toEqual(['leftover']);

    // A fresh idle send drains the leftover ahead of the new message, as one turn.
    await sendUserMessage(sessionId, 'new');
    await waitFor(() => fake.inputs.length >= 2);
    expect(fake.inputs[1].message.content).toBe('leftover\n\nnew');
    expect(getQueuedMessages(sessionId)).toHaveLength(0);
    expect(isClaudeRunning(sessionId)).toBe(true);

    stopSession(sessionId);
  });

  it('re-queues (does not lose) messages when a flush fails to persist', async () => {
    // Non-destructive flush: if preparing/persisting a queued message throws at
    // turn end, the messages must be handed back to the queue (not silently lost)
    // and the session must go idle rather than pin the composer "working".
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'first');
    fake.emit(messageStart());
    await waitFor(() => isClaudeRunning(sessionId));

    // Queue a message with an attachment; resolving it will blow up during flush.
    await sendUserMessage(sessionId, 'has attachment', ['aaaa1111-doc.md']);
    expect(getQueuedMessages(sessionId).map((m) => m.text)).toEqual(['has attachment']);
    mockResolveUploadPaths.mockRejectedValueOnce(new Error('fs boom'));

    // Turn ends naturally → flush fires → prepare throws → non-destructive recovery.
    fake.emit(messageDelta('end_turn'));
    fake.emit(result());
    await waitFor(() => !isClaudeRunning(sessionId));

    // The message is back in the queue (with its attachment), nothing was pushed to
    // the SDK, and the composer is idle.
    const requeued = getQueuedMessages(sessionId);
    expect(requeued.map((m) => m.text)).toEqual(['has attachment']);
    expect(requeued[0].attachments).toEqual(['aaaa1111-doc.md']);
    expect(fake.inputs).toHaveLength(1);
    expect(mockSseEvents.emitClaudeRunning).toHaveBeenLastCalledWith(sessionId, false);

    stopSession(sessionId);
  });

  it('leaves the queue intact when interrupted during the flush window (before the push)', async () => {
    // The interrupt-vs-flush race: the turn ends naturally and the flush starts,
    // but the user hits Stop while the flush is still preparing (before it pushes).
    // The flush must abort — re-queue and go idle — NOT fire the queue as a turn.
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'first');
    fake.emit(messageStart());
    await waitFor(() => isClaudeRunning(sessionId));
    await sendUserMessage(sessionId, 'queued', ['aaaa1111-doc.md']);

    // Make attachment resolution hang so we can interrupt mid-flush.
    let release!: () => void;
    mockResolveUploadPaths.mockReturnValueOnce(
      new Promise((res) => {
        release = () => res(['/p/doc.md']);
      })
    );

    // Turn ends → the flush starts and blocks in prepare.
    fake.emit(messageDelta('end_turn'));
    fake.emit(result());
    await waitFor(() => mockResolveUploadPaths.mock.calls.length >= 1);

    // User hits Stop during the flush window.
    expect(await interruptClaude(sessionId)).toBe(true);

    // Let prepare finish; the flush detects the interrupt, re-queues, goes idle.
    release();
    await waitFor(() => !isClaudeRunning(sessionId));

    expect(fake.inputs).toHaveLength(1); // the queue was NOT pushed as a new turn
    expect(getQueuedMessages(sessionId).map((m) => m.text)).toEqual(['queued']);

    stopSession(sessionId);
  });

  it('holds turnActive continuously across the flush handoff (stream events + interleaved task)', async () => {
    // Reproduces the real message ordering: the turn ends via a terminal
    // message_delta, a task_notification lands before the trailing result, then
    // the flushed turn opens with its own message_start. turnActive must never
    // dip to false across the whole handoff (which would trip work-complete
    // notifications / voice auto-read on the client).
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'first');
    await waitFor(() => fake.inputs.length >= 1);

    // Turn 1 streams and the user queues a follow-up mid-turn.
    fake.emit(messageStart());
    await waitFor(() => isClaudeRunning(sessionId));
    await sendUserMessage(sessionId, 'follow up');

    mockSseEvents.emitClaudeRunning.mockClear();
    mockSseEvents.emitClaudeFinished.mockClear();

    // Turn 1 ends; a task notification lands before the trailing result.
    fake.emit(messageDelta('end_turn'));
    fake.emit(taskNotification('task-x'));
    fake.emit(result());

    // The queued prompt flushed as a new turn.
    await waitFor(() => fake.inputs.length >= 2);
    expect(fake.inputs[1].message.content).toBe('follow up');

    // The flushed turn opens; then ends normally.
    fake.emit(messageStart());
    // Across the entire handoff, turnActive never dropped to false.
    expect(mockSseEvents.emitClaudeRunning).not.toHaveBeenCalledWith(sessionId, false);
    expect(isClaudeRunning(sessionId)).toBe(true);
    // The intermediate (flushed-over) turn end is NOT a completion — no work-complete
    // signal fires until the final turn ends.
    expect(mockSseEvents.emitClaudeFinished).not.toHaveBeenCalled();

    // The final turn ending (no more queued prompts) clears turnActive exactly once.
    fake.emit(messageDelta('end_turn'));
    await waitFor(() => !isClaudeRunning(sessionId));
    expect(mockSseEvents.emitClaudeRunning).toHaveBeenCalledWith(sessionId, false);
    // Exactly one work-complete signal, for the whole handoff.
    expect(mockSseEvents.emitClaudeFinished).toHaveBeenCalledTimes(1);

    stopSession(sessionId);
  });

  it('recovers turnActive when interrupted during the flush handoff (no message_start)', async () => {
    // Regression: interrupting after queued prompts flushed but before the
    // flushed turn's message_start must not strand awaitingFlushTurn/turnActive
    // true. The interrupt's terminal result has no preceding message_start, so
    // without the interrupt-time flag reset the composer would be silently dead.
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'first');
    fake.emit(messageStart());
    await waitFor(() => isClaudeRunning(sessionId));
    await sendUserMessage(sessionId, 'queued');

    // Turn 1 ends → 'queued' flushes; turnActive is held true awaiting the
    // flushed turn's message_start.
    fake.emit(messageDelta('end_turn'));
    await waitFor(() => fake.inputs.length >= 2);
    expect(isClaudeRunning(sessionId)).toBe(true);

    // User hits Stop during the handoff, then the interrupt's terminal result
    // lands with no top-level message_start for the flushed turn.
    expect(await interruptClaude(sessionId)).toBe(true);
    fake.emit(result('error_during_execution'));

    // turnActive recovers instead of being pinned true forever.
    await waitFor(() => !isClaudeRunning(sessionId));

    stopSession(sessionId);
  });

  it('applies a model change live on the next send', async () => {
    const fake = makeFakeQuery();
    _setQueryFactory(fake.factory);
    const sessionId = await createRunningSession();

    // Turn 1 with the default (no model override).
    await sendUserMessage(sessionId, 'first');
    fake.emit(result());
    await waitFor(() => !isClaudeRunning(sessionId));
    expect(fake.setModel).not.toHaveBeenCalled();

    // The user changes the model; the next send applies it live.
    mockLoadSettings.mockResolvedValue({ ...baseSettings, claudeModel: 'opus' });
    await sendUserMessage(sessionId, 'second');
    expect(fake.setModel).toHaveBeenCalledWith('opus');

    fake.emit(result());
    await waitFor(() => !isClaudeRunning(sessionId));
    stopSession(sessionId);
  });

  it('stitches a PostToolUse sanitizer finding onto the persisted tool_result message', async () => {
    // End-to-end seam: the real PostToolUse hook records a finding into the
    // per-session map (keyed by tool_use_id), and runSessionLoop attaches it to
    // the matching tool_result block before persisting. Exercises the wiring the
    // pure unit tests can't (hook callback → map → persist).
    const fake = makeFakeQuery();
    let options: unknown;
    _setQueryFactory((p) => {
      options = p.options;
      return fake.factory(p);
    });
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'run a command');

    // Fire the real hook with tool output containing an invisible zero-width char,
    // exactly as the SDK would post-tool. This records the finding in the map.
    const hook = extractPostToolUseHook(options);
    await hook({
      hook_event_name: 'PostToolUse',
      session_id: 's',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/tmp/spike-runner-test',
      tool_name: 'Bash',
      tool_input: {},
      tool_response: {
        stdout: `value${ZWSP}hidden`,
        stderr: '',
        interrupted: false,
        isImage: false,
      },
      tool_use_id: 'toolu_x',
    });

    // The matching tool_result streams back and is persisted with the badge.
    fake.emit(toolResultMsg('toolu_x', 'value hidden'));
    fake.emit(result());

    await waitFor(async () =>
      (await messagesFor(sessionId)).some((m) => m.type === 'user' && m.content.includes('toolu_x'))
    );

    const rows = await messagesFor(sessionId);
    const toolResultRow = rows.find((m) => m.type === 'user' && m.content.includes('toolu_x'));
    const content = JSON.parse(toolResultRow!.content) as {
      message: {
        content: Array<{
          tool_use_id?: string;
          sanitization?: { removed: boolean; found: string[] };
        }>;
      };
    };
    const block = content.message.content.find((b) => b.tool_use_id === 'toolu_x');
    expect(block?.sanitization).toBeDefined();
    expect(block?.sanitization?.removed).toBe(true);
    expect(block?.sanitization?.found.length).toBeGreaterThan(0);

    await waitFor(() => !isClaudeRunning(sessionId));
    stopSession(sessionId);
  });

  it('does not attach a sanitization field to a clean tool_result', async () => {
    const fake = makeFakeQuery();
    let options: unknown;
    _setQueryFactory((p) => {
      options = p.options;
      return fake.factory(p);
    });
    const sessionId = await createRunningSession();

    await sendUserMessage(sessionId, 'run a command');

    // Clean output → hook records nothing → no badge on the tool_result.
    const hook = extractPostToolUseHook(options);
    await hook({
      hook_event_name: 'PostToolUse',
      session_id: 's',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/tmp/spike-runner-test',
      tool_name: 'Bash',
      tool_input: {},
      tool_response: { stdout: 'all good', stderr: '', interrupted: false, isImage: false },
      tool_use_id: 'toolu_clean',
    });

    fake.emit(toolResultMsg('toolu_clean', 'all good'));
    fake.emit(result());

    await waitFor(async () =>
      (await messagesFor(sessionId)).some(
        (m) => m.type === 'user' && m.content.includes('toolu_clean')
      )
    );

    const rows = await messagesFor(sessionId);
    const toolResultRow = rows.find((m) => m.type === 'user' && m.content.includes('toolu_clean'));
    const content = JSON.parse(toolResultRow!.content) as {
      message: { content: Array<{ sanitization?: unknown }> };
    };
    expect(content.message.content[0].sanitization).toBeUndefined();

    await waitFor(() => !isClaudeRunning(sessionId));
    stopSession(sessionId);
  });

  it('stopSession during establish does not resurrect the session (no orphan query)', async () => {
    const fake = makeFakeQuery();
    let factoryCalls = 0;
    _setQueryFactory((p) => {
      factoryCalls += 1;
      return fake.factory(p);
    });
    const sessionId = await createRunningSession();

    // Make settings loading hang so we can interleave a stop mid-establish.
    let releaseSettings!: () => void;
    mockLoadSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseSettings = () => resolve({ ...baseSettings });
      })
    );

    const sendResult = sendUserMessage(sessionId, 'hi').then(
      () => 'resolved',
      (e: Error) => e
    );
    // Let ensureSessionQuery reach the awaited (hanging) settings load.
    await new Promise((r) => setTimeout(r, 30));
    // Stop while establishing — deletes the in-memory entry.
    stopSession(sessionId);
    // Release settings; establish should detect the teardown and abort.
    releaseSettings();

    const result = await sendResult;
    expect(result).toBeInstanceOf(Error);
    expect(factoryCalls).toBe(0); // no query was ever created
    expect(isClaudeRunning(sessionId)).toBe(false);
    expect(getSessionBackgroundTasks(sessionId)).toEqual([]);
  });

  it('assigns unique contiguous sequences under concurrent inserts (no collision)', async () => {
    const sessionId = await createRunningSession();
    const N = 50;

    // Fire N inserts for the SAME session concurrently. With a read-then-insert
    // this races on @@unique([sessionId, sequence]); the atomic counter must give
    // each a distinct sequence.
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        insertMessage({
          sessionId,
          id: `msg-${i}`,
          type: 'assistant',
          content: { type: 'assistant', i },
        })
      )
    );

    // Every insert succeeded and got a sequence.
    expect(results.every((r) => r.inserted)).toBe(true);
    const sequences = results.map((r) => r.sequence!).sort((a, b) => a - b);
    expect(sequences).toEqual([...Array(N).keys()]);

    // The DB agrees: N rows with contiguous sequences 0..N-1.
    const rows = await messagesFor(sessionId);
    expect(rows.map((m) => m.sequence)).toEqual([...Array(N).keys()]);

    // The counter points at the next sequence.
    const session = await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.messageSequence).toBe(N);
  });

  it('is idempotent on a duplicate id (no-op, no second row)', async () => {
    const sessionId = await createRunningSession();

    const first = await insertMessage({
      sessionId,
      id: 'dup',
      type: 'user',
      content: { type: 'user', content: 'hi' },
    });
    expect(first).toEqual({ inserted: true, sequence: 0 });

    // Same id again: the create fails on the primary key and it is a no-op.
    const second = await insertMessage({
      sessionId,
      id: 'dup',
      type: 'user',
      content: { type: 'user', content: 'hi' },
    });
    expect(second).toEqual({ inserted: false });

    // The reserved sequence (1) is skipped — the next distinct insert lands at 2.
    // A gap is harmless: pagination orders by sequence and never assumes contiguity.
    const third = await insertMessage({
      sessionId,
      id: 'next',
      type: 'assistant',
      content: { type: 'assistant' },
    });
    expect(third).toEqual({ inserted: true, sequence: 2 });

    // Only the two real rows exist (the duplicate never created one).
    const rows = await messagesFor(sessionId);
    expect(rows.map((m) => m.sequence)).toEqual([0, 2]);
  });
});
