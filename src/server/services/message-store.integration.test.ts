import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { createTestSession } from '@/test/fixtures';
import { runMigrationBackfill } from '@/test/migration-backfill';
import { messageDisplay } from '@/lib/transcript-display';
import { projectMessageContent } from '@/lib/tool-result';
import type { DbMessageType } from '@/lib/claude-messages';
import { sseEvents } from './events';
import { redactSecretsDeep } from './secret-redaction';

vi.mock('./events', () => ({ sseEvents: { emitNewMessage: vi.fn(), emitTokenUsage: vi.fn() } }));
vi.mock('./secret-redaction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secret-redaction')>();
  return { ...actual, redactSecretsDeep: vi.fn(actual.redactSecretsDeep) };
});

const blocks = (...content: unknown[]) => ({ message: { content } });

/** One of each shape messageDisplay distinguishes, including its edge cases. */
const DISPLAY_FIXTURES: [DbMessageType, unknown][] = [
  ['user', { type: 'user', content: 'a prompt' }],
  ['user', { type: 'user', ...blocks({ type: 'text', text: 'array prompt' }) }],
  ['user', { type: 'user', subtype: 'interrupt', content: 'Interrupted' }],
  ['user', { type: 'user', ...blocks({ type: 'tool_result', tool_use_id: 't1', content: 'x' }) }],
  [
    'user',
    {
      type: 'user',
      parent_tool_use_id: 'task-1',
      ...blocks({ type: 'tool_result', tool_use_id: 't2', content: 'x' }),
    },
  ],
  ['assistant', { type: 'assistant', ...blocks({ type: 'text', text: 'hello' }) }],
  ['assistant', { type: 'assistant', ...blocks({ type: 'text', text: ' \n\t ' }) }],
  ['assistant', { type: 'assistant', ...blocks({ type: 'text', text: 42 }) }],
  [
    'assistant',
    { type: 'assistant', ...blocks({ type: 'thinking', thinking: '', signature: 's' }) },
  ],
  ['assistant', { type: 'assistant', ...blocks({ type: 'thinking', thinking: 'An update.' }) }],
  ['assistant', { type: 'assistant', ...blocks({ type: 'tool_use', id: 't3', name: 'Bash' }) }],
  ['assistant', { type: 'assistant', ...blocks({ type: 'redacted_thinking', data: 'x' }) }],
  ['assistant', { type: 'assistant', ...blocks({ type: 'server_tool_use', id: 's1' }) }],
  ['assistant', { type: 'assistant', ...blocks({ type: 'advisor_tool_result', content: {} }) }],
  ['assistant', { type: 'assistant', ...blocks() }],
  ['assistant', { type: 'assistant', message: { content: 'a string' } }],
  ['assistant', { type: 'assistant', ...blocks(null, { type: 'text', text: 'after null' }) }],
  [
    'assistant',
    { type: 'assistant', parent_tool_use_id: 'task-1', ...blocks({ type: 'text', text: 'child' }) },
  ],
  [
    'assistant',
    {
      type: 'assistant',
      parent_tool_use_id: 'task-1',
      ...blocks({ type: 'thinking', thinking: '' }),
    },
  ],
  [
    'assistant',
    { type: 'assistant', parent_tool_use_id: null, ...blocks({ type: 'text', text: 'top' }) },
  ],
  ['system', { type: 'system', subtype: 'init', model: 'm' }],
  ['system', { type: 'system', subtype: 'error', content: [{ type: 'text', text: 'boom' }] }],
  ['system', { type: 'system', subtype: 'compact_boundary' }],
  ['system', { type: 'system', subtype: 'model_refusal_fallback', retracted_message_uuids: [] }],
  ['system', { type: 'system', subtype: 'error', parent_tool_use_id: 'task-1', content: [] }],
  ['system', { type: 'system', subtype: 'task_started', tool_use_id: 'task-1' }],
  ['system', { type: 'system', subtype: 'task_notification', tool_use_id: 'task-1' }],
  ['system', { type: 'system', subtype: 'background_tasks_changed' }],
  ['system', { type: 'rate_limit_event' }],
  ['system', { type: 'tool_progress', parent_tool_use_id: 'task-1' }],
  ['result', { type: 'result', subtype: 'success', session_id: 's' }],
  // Odd shapes the backfill must classify like the live path, not abort on.
  ['user', { type: 'user', message: { content: ['hello', null, 7] } }],
  ['assistant', { type: 'assistant', message: { content: ['hello', null, 7] } }],
  [
    'assistant',
    { type: 'assistant', message: { content: { type: 'text', text: 'not an array' } } },
  ],
  ['assistant', { type: 'assistant', ...blocks({ type: 7, text: 'numeric type' }) }],
  ['assistant', { type: 'assistant', ...blocks({ type: 'text', text: '\u00a0' }) }],
  ['assistant', { type: 'assistant', ...blocks({ type: 'text', text: ' \u000b\f\r' }) }],
  ['assistant', 'just a string'],
  ['user', null],
  ['assistant', null],
  ['system', null],
  ['system', { type: 'system', subtype: 5 }],
];

let store: typeof import('./message-store');

async function seed(sessionId: string, contents: unknown[]) {
  await testPrisma.message.createMany({
    data: contents.map((content, sequence) => ({
      sessionId,
      sequence,
      type: 'assistant',
      content: JSON.stringify(content),
    })),
  });
}

beforeAll(async () => {
  await setupTestDb();
  // After setupTestDb, so @/lib/prisma binds to the test database.
  store = await import('./message-store');
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearTestDb();
});

describe('message-store reads', () => {
  it('replays only messages after the floor, oldest first, with decoded content', async () => {
    const session = await createTestSession();
    const other = await createTestSession();
    await seed(session.id, [{ n: 0 }, { n: 1 }, { n: 2 }]);
    await seed(other.id, [{ n: 9 }, { n: 9 }, { n: 9 }]);

    const missed = await store.loadMessagesAfter(session.id, 0);

    expect(missed.map((m) => [m.sequence, m.content])).toEqual([
      [1, { n: 1 }],
      [2, { n: 2 }],
    ]);
  });

  it('pages history backward and reports whether older messages remain', async () => {
    const session = await createTestSession();
    await seed(
      session.id,
      Array.from({ length: 5 }, (_, n) => ({ n }))
    );

    const newest = await store.loadHistoryPage(session.id, null, 2);
    expect(newest.messages.map((m) => m.content)).toEqual([{ n: 3 }, { n: 4 }]);
    expect(newest.hasMore).toBe(true);

    const oldest = await store.loadHistoryPage(session.id, 2, 2);
    expect(oldest.messages.map((m) => m.content)).toEqual([{ n: 0 }, { n: 1 }]);
    expect(oldest.hasMore).toBe(false);
  });

  describe('with context and hidden messages', () => {
    const prompt = (text: string): [DbMessageType, unknown] => [
      'user',
      { type: 'user', content: text },
    ];
    const call = (id: string): [DbMessageType, unknown] => [
      'assistant',
      { type: 'assistant', ...blocks({ type: 'tool_use', id, name: 'Bash', input: {} }) },
    ];
    const result = (id: string): [DbMessageType, unknown] => [
      'user',
      { type: 'user', ...blocks({ type: 'tool_result', tool_use_id: id, content: 'ok' }) },
    ];
    const init: [DbMessageType, unknown] = ['system', { type: 'system', subtype: 'init' }];
    const child: [DbMessageType, unknown] = [
      'assistant',
      { type: 'assistant', parent_tool_use_id: 'c1', ...blocks({ type: 'text', text: 'child' }) },
    ];

    // Sequence: 0 init, 1 prompt, 2 call c1, 3 child, 4 init, 5 result c1, 6 prompt,
    // 7 call c2, 8 result c2.
    const TRANSCRIPT = [
      init,
      prompt('first'),
      call('c1'),
      child,
      init,
      result('c1'),
      prompt('second'),
      call('c2'),
      result('c2'),
    ];

    async function insertAll(sessionId: string) {
      for (const [n, [type, content]] of TRANSCRIPT.entries()) {
        await store.insertMessage({ sessionId, id: `${sessionId}-${n}`, type, content });
      }
    }
    const sequences = (messages: { sequence: number }[]) => messages.map((m) => m.sequence);

    it('counts only rows toward a page, and ships the context between them', async () => {
      const session = await createTestSession();
      await insertAll(session.id);

      const newest = await store.loadHistoryPage(session.id, null, 2);
      expect(sequences(newest.messages)).toEqual([6, 7, 8]);
      expect(newest.hasMore).toBe(true);

      const middle = await store.loadHistoryPage(session.id, 6, 1);
      expect(sequences(middle.messages)).toEqual([2, 3, 5]);
      expect(middle.hasMore).toBe(true);

      // The last page reaches back to the start, leaving out only hidden messages.
      const oldest = await store.loadHistoryPage(session.id, 2, 1);
      expect(sequences(oldest.messages)).toEqual([1]);
      expect(oldest.hasMore).toBe(false);
    });

    it('leaves hidden messages out of a resumed snapshot', async () => {
      const session = await createTestSession();
      await insertAll(session.id);

      expect(sequences(await store.loadMessagesAfter(session.id, 3))).toEqual([5, 6, 7, 8]);
      expect(await store.hasMessagesThrough(session.id, 0)).toBe(false);
      expect(await store.hasMessagesThrough(session.id, 1)).toBe(true);
    });

    it('reads transcript rows alone for another agent', async () => {
      const session = await createTestSession();
      await insertAll(session.id);

      const newest = await store.loadTranscriptRows(session.id, null, 2);
      expect(sequences(newest.messages)).toEqual([6, 7]);
      expect(newest.hasMore).toBe(true);
      const oldest = await store.loadTranscriptRows(session.id, 6, 5);
      expect(sequences(oldest.messages)).toEqual([1, 2]);
      expect(oldest.hasMore).toBe(false);
    });
  });
});

describe('client projection', () => {
  it('stores a tool result raw but announces it as reads deliver it', async () => {
    const session = await createTestSession();
    const content = {
      type: 'user',
      tool_use_result: { stdout: 'raw' },
      ...blocks({ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(5000) }),
    };

    await store.insertMessage({ sessionId: session.id, id: 'r1', type: 'user', content });

    const stored = await testPrisma.message.findUniqueOrThrow({ where: { id: 'r1' } });
    expect(JSON.parse(stored.content)).toEqual(content);
    const [read] = await store.loadMessagesAfter(session.id, -1);
    expect(read.content).toEqual(projectMessageContent(content));
    expect(sseEvents.emitNewMessage).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ id: 'r1', content: read.content })
    );
    expect(await store.loadToolResultText(session.id, 'r1', 't1')).toBe('x'.repeat(5000));
  });

  it('leaves server-side transcript reads raw', async () => {
    const session = await createTestSession();
    const content = {
      type: 'assistant',
      wire_tool_inputs: { t1: {} },
      message: { content: [{ type: 'text', text: 'hi' }], input_transformations: [{}] },
    };
    await store.insertMessage({ sessionId: session.id, id: 'a1', type: 'assistant', content });

    const { messages } = await store.loadTranscriptRows(session.id, null, 10);

    expect(messages.map((m) => m.content)).toEqual([content]);
  });
});

describe('secret redaction', () => {
  // Assembled at runtime so this file doesn't itself trip secret scanners.
  const GITHUB_TOKEN = 'ghp' + '_' + 'A1b2C3d4'.repeat(4) + 'E5f6';
  const withToken = {
    type: 'user',
    ...blocks({ type: 'text', text: `use ${GITHUB_TOKEN} please` }),
  };
  const redacted = {
    type: 'user',
    ...blocks({ type: 'text', text: 'use [REDACTED:github] please' }),
  };

  it('redacts secrets before storing and announcing a message', async () => {
    const session = await createTestSession();

    await store.insertMessage({
      sessionId: session.id,
      id: 'p1',
      type: 'user',
      content: withToken,
    });

    const stored = await testPrisma.message.findUniqueOrThrow({ where: { id: 'p1' } });
    expect(JSON.parse(stored.content)).toEqual(redacted);
    expect(sseEvents.emitNewMessage).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ id: 'p1', content: redacted })
    );
  });

  it('stores a visible error instead of the message when redaction fails', async () => {
    const session = await createTestSession();
    vi.mocked(redactSecretsDeep).mockRejectedValueOnce(new Error('scanner broke'));

    const { inserted } = await store.insertMessage({
      sessionId: session.id,
      id: 'p1',
      type: 'assistant',
      content: { type: 'assistant', ...blocks({ type: 'text', text: `use ${GITHUB_TOKEN}` }) },
    });

    expect(inserted).toBe(true);
    const stored = await testPrisma.message.findUniqueOrThrow({ where: { id: 'p1' } });
    expect(stored.type).toBe('system');
    expect(stored.display).toBe('row');
    expect(stored.content).not.toContain(GITHUB_TOKEN);
    expect(JSON.parse(stored.content)).toMatchObject({ type: 'system', subtype: 'error' });
    expect(sseEvents.emitNewMessage).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ id: 'p1', type: 'system' })
    );
    expect(JSON.stringify(vi.mocked(sseEvents.emitNewMessage).mock.calls)).not.toContain(
      GITHUB_TOKEN
    );
  });

  it('still counts the usage of a result it could not redact', async () => {
    const session = await createTestSession();
    vi.mocked(redactSecretsDeep).mockRejectedValueOnce(new Error('scanner broke'));
    const result = { type: 'result', subtype: 'success', total_cost_usd: 1.5 };

    await store.insertMessage({ sessionId: session.id, id: 'r1', type: 'result', content: result });

    const usage = await testPrisma.sessionUsage.findUniqueOrThrow({
      where: { sessionId: session.id },
    });
    expect(usage.resultCount).toBe(1);
  });
});

describe('markLastMessageAsInterrupted', () => {
  it('marks the last assistant row, not a later subagent message or empty fragment', async () => {
    const session = await createTestSession();
    const insert = (id: string, content: unknown) =>
      store.insertMessage({ sessionId: session.id, id, type: 'assistant', content });
    await insert('reply', { type: 'assistant', ...blocks({ type: 'text', text: 'working' }) });
    await insert('child', {
      type: 'assistant',
      parent_tool_use_id: 'task-1',
      ...blocks({ type: 'text', text: 'child' }),
    });
    await insert('fragment', { type: 'assistant', ...blocks({ type: 'thinking', thinking: '' }) });

    await store.markLastMessageAsInterrupted(session.id);

    const rows = await testPrisma.message.findMany({
      where: { sessionId: session.id },
      orderBy: { sequence: 'asc' },
    });
    const interrupted = rows.filter((r) => JSON.parse(r.content).interrupted === true);
    expect(interrupted.map((r) => r.id)).toEqual(['reply']);
    expect(JSON.parse(rows[rows.length - 1].content)).toMatchObject({ subtype: 'interrupt' });
  });
});

describe('message-store display classification', () => {
  async function displays(sessionId: string): Promise<string[]> {
    const rows = await testPrisma.message.findMany({
      where: { sessionId },
      orderBy: { sequence: 'asc' },
      select: { display: true },
    });
    return rows.map((r) => r.display);
  }

  it('stores messageDisplay on insert', async () => {
    const session = await createTestSession();
    for (const [n, [type, content]] of DISPLAY_FIXTURES.entries()) {
      await store.insertMessage({ sessionId: session.id, id: `m${n}`, type, content });
    }

    const expected = DISPLAY_FIXTURES.map(([type, content]) => messageDisplay(type, content));
    expect(await displays(session.id)).toEqual(expected);
    // The fixtures exercise every class.
    expect(new Set(expected)).toEqual(new Set(['row', 'context', 'hidden']));
  });

  it('backfills existing messages exactly as messageDisplay classifies them', async () => {
    const live = await createTestSession();
    const backfilled = await createTestSession();
    for (const [n, [type, content]] of DISPLAY_FIXTURES.entries()) {
      await store.insertMessage({ sessionId: live.id, id: `live-${n}`, type, content });
    }
    // Rows from before the column existed: the default, then the backfill.
    await testPrisma.message.createMany({
      data: DISPLAY_FIXTURES.map(([type, content], sequence) => ({
        sessionId: backfilled.id,
        sequence,
        type,
        content: JSON.stringify(content),
      })),
    });

    await runMigrationBackfill('_message_display');

    expect(await displays(backfilled.id)).toEqual(await displays(live.id));
  });
});
