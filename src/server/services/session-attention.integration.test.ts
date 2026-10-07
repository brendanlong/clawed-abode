import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { createTestSession } from '@/test/fixtures';
import type { SessionListEvent } from './events';

let attention: typeof import('./session-attention');
let messageStore: typeof import('./message-store');
let events: typeof import('./events');
let lifecycle: typeof import('./session-lifecycle');

const attentionOf = (id: string) =>
  testPrisma.session.findUniqueOrThrow({
    where: { id },
    select: { attentionAt: true, attentionSummary: true },
  });

describe('session attention', () => {
  const listEvents: SessionListEvent[] = [];
  let unsubscribe: () => void;

  beforeAll(async () => {
    await setupTestDb();
    // After setupTestDb, so @/lib/prisma binds to the test database.
    attention = await import('./session-attention');
    messageStore = await import('./message-store');
    events = await import('./events');
    lifecycle = await import('./session-lifecycle');
    unsubscribe = events.sseEvents.onSessionListChanged((e) => listEvents.push(e));
  });

  afterAll(async () => {
    unsubscribe();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    listEvents.length = 0;
  });

  it('records the request and announces it to the session list', async () => {
    const session = await createTestSession({ name: 'Login fix' });

    await attention.requestAttention(session.id, 'PR ready');

    expect(await attentionOf(session.id)).toMatchObject({ attentionSummary: 'PR ready' });
    expect((await attentionOf(session.id)).attentionAt).toBeInstanceOf(Date);
    expect(listEvents).toContainEqual({
      kind: 'attention',
      sessionId: session.id,
      name: 'Login fix',
      summary: 'PR ready',
    });
  });

  it('ignores a request for an archived session', async () => {
    const session = await createTestSession({ status: 'archived' });

    await attention.requestAttention(session.id, 'PR ready');

    expect(await attentionOf(session.id)).toEqual({ attentionAt: null, attentionSummary: null });
    expect(listEvents).toEqual([]);
  });

  it('clears on a user interaction', async () => {
    const session = await createTestSession();
    await attention.requestAttention(session.id, 'PR ready');

    await messageStore.bumpSessionActivity(session.id);

    expect(await attentionOf(session.id)).toEqual({ attentionAt: null, attentionSummary: null });
  });

  it('clears when the session is archived', async () => {
    const session = await createTestSession();
    await attention.requestAttention(session.id, 'PR ready');

    await lifecycle.archiveSession(session.id);

    expect(await attentionOf(session.id)).toEqual({ attentionAt: null, attentionSummary: null });
  });

  it('pushes no update when there was nothing to clear', async () => {
    const session = await createTestSession();
    const listener = vi.fn();
    const off = events.sseEvents.onSessionEvents(session.id, listener);

    await attention.clearAttention(session.id);

    off();
    expect(listener).not.toHaveBeenCalled();
  });
});
