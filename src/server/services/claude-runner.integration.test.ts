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
  emitClaudeRetry: vi.fn(),
  emitBackgroundTasks: vi.fn(),
  emitCommands: vi.fn(),
  emitSessionUpdate: vi.fn(),
  emitPrUpdate: vi.fn(),
}));
vi.mock('./events', () => ({ sseEvents: mockSseEvents }));

vi.mock('./github', () => ({
  fetchPullRequestForBranch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./worktree-manager', () => ({
  getCurrentBranch: vi.fn().mockResolvedValue(null),
  getSessionWorkingDir: vi.fn(() => '/tmp/spike-runner-test'),
}));

vi.mock('./settings-merger', () => ({
  loadMergedSessionSettings: vi.fn().mockResolvedValue({
    systemPrompt: 'test prompt',
    envVars: [],
    mcpServers: [],
    claudeModel: undefined,
    claudeApiKey: undefined,
    customSystemPrompt: null,
    globalSettings: {
      systemPromptOverride: null,
      systemPromptOverrideEnabled: false,
      systemPromptAppend: null,
    },
  }),
}));

import { createPushable } from '@/lib/pushable';

// Imported dynamically in beforeAll (after setupTestDb sets DATABASE_URL), since
// claude-runner pulls in @/lib/prisma at module load.
let sendUserMessage: typeof import('./claude-runner').sendUserMessage;
let stopSession: typeof import('./claude-runner').stopSession;
let isClaudeRunning: typeof import('./claude-runner').isClaudeRunning;
let getSessionBackgroundTasks: typeof import('./claude-runner').getSessionBackgroundTasks;
let _setQueryFactory: typeof import('./claude-runner')._setQueryFactory;

// --- fake SDK query ----------------------------------------------------------
function makeFakeQuery() {
  const out = createPushable<SDKMessage>();
  const inputs: SDKUserMessage[] = [];

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
      stopTask: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      setMcpServers: vi.fn(async () => {}),
    } as unknown as Query;
  };

  return { factory, emit: (m: SDKMessage) => out.push(m), end: () => out.close(), inputs };
}

// --- message builders --------------------------------------------------------
let uuidCounter = 0;
const nextUuid = () => `uuid-${uuidCounter++}`;

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
    stopSession = mod.stopSession;
    isClaudeRunning = mod.isClaudeRunning;
    getSessionBackgroundTasks = mod.getSessionBackgroundTasks;
    _setQueryFactory = mod._setQueryFactory;
  });
  afterAll(async () => {
    await teardownTestDb();
    _setQueryFactory(null);
  });
  beforeEach(async () => {
    await clearTestDb();
    vi.clearAllMocks();
    uuidCounter = 0;
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
});
