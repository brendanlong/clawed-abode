import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { createTestSession } from '@/test/fixtures';

vi.mock('./events', () => ({ sseEvents: { emitNewMessage: vi.fn() } }));

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

describe('message-store reads', () => {
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

  it('reports the latest sequence, or null for an empty transcript', async () => {
    const session = await createTestSession();
    expect(await store.latestSequence(session.id)).toBeNull();

    await seed(session.id, [{}, {}, {}]);
    expect(await store.latestSequence(session.id)).toBe(2);
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

  it('finds the latest top-level assistant message, skipping subagents', async () => {
    const session = await createTestSession();
    expect(await store.loadLastTopLevelAssistantContent(session.id)).toBeUndefined();

    await seed(session.id, [
      { parent_tool_use_id: null, n: 0 },
      { parent_tool_use_id: 'toolu_1', n: 1 },
    ]);

    expect(await store.loadLastTopLevelAssistantContent(session.id)).toEqual({
      parent_tool_use_id: null,
      n: 0,
    });
  });
});
