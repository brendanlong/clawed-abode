import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { createNoRepoSession } from '@/test/fixtures';
import { isTrackedEnvelope } from '@trpc/server';
import {
  applyHistorySnapshot,
  mergeMessageIntoCache,
  removeMessageFromCache,
  HISTORY_PAGE_SIZE,
  partialMessageId,
  type MessageInfiniteCache,
} from '@/lib/message-cache';
import { applySessionStateEvent, type SessionStreamState } from '@/lib/session-stream-state';
import { formatResumeToken } from '@/lib/sse-resume';
import { buildTokenUsageStats, EMPTY_SESSION_USAGE_TOTALS } from '@/lib/token-estimation';
import type { ParsedMessage } from '../services/message-store';
import type { SessionStreamOutput } from './sse';

const mockRefreshStalePullRequests = vi.hoisted(() => vi.fn());
vi.mock('../services/session-branch-pr', () => ({
  refreshStalePullRequests: mockRefreshStalePullRequests,
}));

// The runner holds partials only for a live SDK query, which these tests don't run.
const mockGetActivePartials = vi.hoisted(() => vi.fn((): ParsedMessage[] => []));
vi.mock('../services/claude-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/claude-runner')>()),
  getActivePartials: mockGetActivePartials,
}));

let sseRouter: typeof import('./sse').sseRouter;
let router: typeof import('../trpc').router;
let sseEvents: typeof import('../services/events').sseEvents;
let store: typeof import('../services/message-store');

/** What the client keeps, maintained the way `useSessionStream` does. */
interface Client {
  history: MessageInfiniteCache<ParsedMessage> | undefined;
  state: SessionStreamState | undefined;
}

function apply(client: Client, event: SessionStreamOutput): void {
  switch (event.kind) {
    case 'message':
      client.history = mergeMessageIntoCache(client.history, event.message);
      return;
    case 'message_removed':
      client.history = removeMessageFromCache(client.history, event.messageId);
      return;
    case 'snapshot':
      client.history = applyHistorySnapshot(client.history, event.history);
      break;
  }
  client.state = applySessionStateEvent(client.state, event);
}

/** Chronological ids: pages[0] is the newest page, each page oldest-first. */
const messageIds = (client: Client) =>
  [...(client.history?.pages ?? [])].reverse().flatMap((page) => page.messages.map((m) => m.id));

describe('sse.onSessionEvents', () => {
  beforeAll(async () => {
    await setupTestDb();
    // After setupTestDb, so @/lib/prisma binds to the test database.
    sseRouter = (await import('./sse')).sseRouter;
    router = (await import('../trpc')).router;
    sseEvents = (await import('../services/events')).sseEvents;
    store = await import('../services/message-store');
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    vi.clearAllMocks();
  });

  async function open(sessionId: string, lastEventId?: string) {
    const controller = new AbortController();
    const caller = router({ sse: sseRouter }).createCaller(
      { sessionId: 'auth-session-id' },
      { signal: controller.signal }
    );
    const iterator = (await caller.sse.onSessionEvents({ sessionId, lastEventId }))[
      Symbol.asyncIterator
    ]();
    const next = async () => {
      const { value } = await iterator.next();
      // A server-side caller sees the raw `tracked()` envelopes (the SSE layer
      // unwraps them for real clients), whatever its static type says.
      if (!isTrackedEnvelope<SessionStreamOutput>(value)) throw new Error('untracked event');
      const [id, event] = value;
      return { id, event };
    };
    return { next, close: () => controller.abort() };
  }

  /** Apply events until `done` holds for the client (the test times out otherwise). */
  async function drainUntil(
    stream: Awaited<ReturnType<typeof open>>,
    client: Client,
    done: (client: Client) => boolean
  ) {
    while (!done(client)) apply(client, (await stream.next()).event);
  }

  const insert = (sessionId: string, id: string) =>
    store.insertMessage({ sessionId, id, type: 'user', content: { text: id } });

  it('opens with a snapshot: the session row, its live state, and the newest page', async () => {
    const session = await createNoRepoSession({ name: 'Snap' });
    for (let i = 0; i < HISTORY_PAGE_SIZE + 2; i++) await insert(session.id, `m${i}`);

    const stream = await open(session.id);
    const { id, event } = await stream.next();
    stream.close();

    expect(event).toMatchObject({
      kind: 'snapshot',
      session: { id: session.id, name: 'Snap', status: 'running', canStop: true },
      live: {
        running: false,
        commands: [],
        retry: null,
        backgroundTasks: [],
        pendingMessageIds: [],
        queuedMessageIds: [],
        rateLimitHold: null,
        tokenUsage: buildTokenUsageStats(EMPTY_SESSION_USAGE_TOTALS),
      },
      history: { after: 1, hasMore: true, partials: [] },
    });
    if (event.kind !== 'snapshot') throw new Error('unreachable');
    expect(event.history.messages.map((m) => m.sequence)).toEqual(
      Array.from({ length: HISTORY_PAGE_SIZE }, (_, i) => i + 2)
    );
    // The resume watermark is the newest message the snapshot delivered.
    expect(id).toBe(formatResumeToken(HISTORY_PAGE_SIZE + 1, 1));
    // A view re-arms the PR poll, as the session list does.
    expect(mockRefreshStalePullRequests).toHaveBeenCalledWith([
      expect.objectContaining({ id: session.id }),
    ]);
  });

  it("carries persisted live state: the rate-limit queue's prompt ids, in queue order", async () => {
    const session = await createNoRepoSession();
    const prompt = { sessionId: session.id, content: 'x', text: 'x', attachments: '[]' };
    await testPrisma.queuedPrompt.createMany({
      data: [
        { ...prompt, position: 1, messageId: 'second' },
        { ...prompt, position: 0, messageId: 'first' },
      ],
    });

    const stream = await open(session.id);
    const { event } = await stream.next();
    stream.close();
    expect(event).toMatchObject({ live: { queuedMessageIds: ['first', 'second'] } });
  });

  it('includes what changed before the client connected (#651)', async () => {
    // The page used to read history separately, then connect anchored at the
    // newest sequence; with an empty first read that anchor was "none", so the
    // first messages and the creating → running flip landed in neither.
    const session = await createNoRepoSession({ status: 'creating' });
    await testPrisma.session.update({ where: { id: session.id }, data: { status: 'running' } });
    await insert(session.id, 'initial-prompt');

    const stream = await open(session.id);
    const client: Client = { history: undefined, state: undefined };
    apply(client, (await stream.next()).event);
    stream.close();

    expect(client.state?.session.status).toBe('running');
    expect(messageIds(client)).toEqual(['initial-prompt']);
  });

  it('delivers changes that race the snapshot read, so snapshot + deltas leave no gap (#651)', async () => {
    const session = await createNoRepoSession({ status: 'creating' });
    const stream = await open(session.id);
    const client: Client = { history: undefined, state: undefined };

    // Start the stream (it subscribes, then reads), and change everything while
    // that read may be in flight: setup finishes and the initial prompt persists.
    const first = stream.next();
    const running = await testPrisma.session.update({
      where: { id: session.id },
      data: { status: 'running' },
    });
    sseEvents.emitSessionUpdate(session.id, running);
    await insert(session.id, 'initial-prompt');
    sseEvents.emitClaudeRunning(session.id, true);

    apply(client, (await first).event);
    await drainUntil(
      stream,
      client,
      (c) =>
        c.state?.session.status === 'running' &&
        c.state.live.running &&
        messageIds(c).includes('initial-prompt')
    );
    stream.close();
  });

  it('streams deltas after the snapshot', async () => {
    const session = await createNoRepoSession();
    const stream = await open(session.id);
    expect((await stream.next()).event.kind).toBe('snapshot');

    await insert(session.id, 'hello');
    const message = await stream.next();
    expect(message.event).toMatchObject({ kind: 'message', message: { id: 'hello', sequence: 0 } });
    expect(message.id).toBe(formatResumeToken(0, 2));

    sseEvents.emitClaudeRunning(session.id, true);
    expect((await stream.next()).event).toEqual({ kind: 'running', running: true });
    stream.close();
  });

  it('carries token usage in the snapshot and pushes it when a message moves it', async () => {
    const session = await createNoRepoSession();
    const insertTyped = (
      type: 'system' | 'user' | 'assistant' | 'result',
      content: unknown,
      id: string = crypto.randomUUID()
    ) => store.insertMessage({ sessionId: session.id, id, type, content });
    const assistant = (usage: Record<string, number>, parent: string | null = null) => ({
      type: 'assistant',
      parent_tool_use_id: parent,
      message: { model: 'claude-opus-4-5', usage },
    });

    await insertTyped('system', { type: 'system', subtype: 'init', model: 'claude-opus-4-5' });
    await insertTyped('assistant', assistant({ input_tokens: 40_000, output_tokens: 1_000 }));
    await insertTyped('result', {
      type: 'result',
      total_cost_usd: 0.3,
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
      },
      modelUsage: { 'claude-opus-4-5': { contextWindow: 1_000_000 } },
    });
    // A subagent runs in its own context, so it doesn't move the context fill.
    await insertTyped('assistant', assistant({ input_tokens: 5, output_tokens: 5 }, 'toolu_1'));
    const lastResult = {
      type: 'result',
      total_cost_usd: 0.5,
      usage: { input_tokens: 2000, output_tokens: 800 },
    };
    await insertTyped('result', lastResult, 'result-2');
    // A replayed duplicate is not inserted, so it must not be counted again.
    expect(await insertTyped('result', lastResult, 'result-2')).toEqual({ inserted: false });

    const stream = await open(session.id);
    const client: Client = { history: undefined, state: undefined };
    apply(client, (await stream.next()).event);
    expect(client.state?.live.tokenUsage).toEqual({
      inputTokens: 3000,
      outputTokens: 1300,
      cacheReadTokens: 100,
      cacheCreationTokens: 50,
      totalTokens: 4300,
      contextWindow: 1_000_000,
      percentUsed: expect.closeTo(4.1, 6),
      model: 'claude-opus-4-5',
      totalCostUsd: 0.5,
    });

    // A message that can't move the stats announces nothing beyond itself; the
    // next top-level call moves the context fill.
    await insertTyped('user', { type: 'user', message: 'hi' }, 'hi');
    await insertTyped('assistant', assistant({ input_tokens: 100_000, output_tokens: 0 }), 'a2');
    const kinds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { event } = await stream.next();
      kinds.push(event.kind);
      apply(client, event);
    }
    stream.close();
    expect(kinds).toEqual(['message', 'message', 'token_usage']);
    expect(client.state?.live.tokenUsage).toMatchObject({ totalTokens: 4300, percentUsed: 10 });
  });

  it('resumes from the token’s watermark with fresh latest-value state', async () => {
    const session = await createNoRepoSession();
    for (const id of ['a', 'b', 'c']) await insert(session.id, id);

    const stream = await open(session.id, formatResumeToken(0, 7));
    const { id, event } = await stream.next();
    stream.close();

    expect(event).toMatchObject({ kind: 'snapshot', session: { id: session.id } });
    if (event.kind !== 'snapshot') throw new Error('unreachable');
    // Everything after the watermark, widened to the whole newest page.
    expect(event.history).toMatchObject({ after: -1, hasMore: false });
    expect(event.history.messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    // The counter keeps increasing across the reconnect (tRPC drops repeated ids).
    expect(id).toBe(formatResumeToken(2, 8));
  });

  it('replays everything after the watermark when more than a page arrived meanwhile', async () => {
    const session = await createNoRepoSession();
    for (let i = 0; i < HISTORY_PAGE_SIZE + 5; i++) await insert(session.id, `m${i}`);

    const stream = await open(session.id, formatResumeToken(1, 0));
    const { event } = await stream.next();
    stream.close();

    if (event.kind !== 'snapshot') throw new Error('unreachable');
    // Messages through the watermark exist, so the client may page back to them.
    expect(event.history).toMatchObject({ after: 1, hasMore: true });
    expect(event.history.messages[0].sequence).toBe(2);
    expect(event.history.messages).toHaveLength(HISTORY_PAGE_SIZE + 3);
  });

  it('heals a removal the client missed while disconnected', async () => {
    const session = await createNoRepoSession();
    for (const id of ['a', 'cancelled', 'c']) await insert(session.id, id);
    const client: Client = { history: undefined, state: undefined };
    const first = await open(session.id);
    const { id: token, event } = await first.next();
    apply(client, event);
    first.close();

    await store.removeMessages(session.id, ['cancelled']);

    const resumed = await open(session.id, token);
    apply(client, (await resumed.next()).event);
    resumed.close();
    expect(messageIds(client)).toEqual(['a', 'c']);
  });

  it('answers a buffer overflow with a snapshot that heals what was dropped', async () => {
    const session = await createNoRepoSession();
    for (const id of ['a', 'cancelled', 'c']) await insert(session.id, id);
    const stream = await open(session.id);
    const client: Client = { history: undefined, state: undefined };
    apply(client, (await stream.next()).event);

    // A stalled consumer: the removal and a flood of deltas behind it overflow the
    // buffer (latest-value events would coalesce instead).
    await store.removeMessages(session.id, ['cancelled']);
    for (let i = 0; i < 1001; i++) sseEvents.emitMessageRemoved(session.id, `gone-${i}`);

    const { event } = await stream.next();
    stream.close();
    expect(event).toMatchObject({ kind: 'snapshot', history: { after: -1 } });
    apply(client, event);
    expect(messageIds(client)).toEqual(['a', 'c']);
  });

  it('carries the in-progress output, which replaces the client’s stale partials', async () => {
    const session = await createNoRepoSession();
    await insert(session.id, 'prompt');
    const client: Client = { history: undefined, state: undefined };
    const first = await open(session.id);
    const { id: token, event } = await first.next();
    apply(client, event);
    first.close();

    // While disconnected the agent streamed further; the client's partial is stale.
    const partialAt = (text: string) => ({
      id: partialMessageId(null),
      sessionId: session.id,
      sequence: 1,
      type: 'assistant',
      content: { text },
      createdAt: new Date(),
    });
    client.history = mergeMessageIntoCache(client.history, partialAt('Hel'));
    mockGetActivePartials.mockReturnValueOnce([partialAt('Hello there')]);

    const resumed = await open(session.id, token);
    apply(client, (await resumed.next()).event);
    resumed.close();
    expect(client.history?.pages[0].messages.map((m) => [m.id, m.content])).toEqual([
      ['prompt', { text: 'prompt' }],
      [partialMessageId(null), { text: 'Hello there' }],
    ]);
  });

  it('rejects an unknown session', async () => {
    const stream = await open('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    await expect(stream.next()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
