import { describe, it, expect, vi } from 'vitest';
import { createEventQueue, isStreamedSessionEvent, sessionEventCoalesceKey } from './sse';
import { partialMessageId } from '@/lib/message-cache';
import { buildTokenUsageStats, EMPTY_SESSION_USAGE_TOTALS } from '@/lib/token-estimation';
import type { SessionStreamEvent } from '../services/events';
import type { ParsedMessage } from '../services/message-store';

/**
 * Wire up a createEventQueue with a controllable fake subscription. Returns the
 * queue handle plus the captured `push` and an `unsubscribed` flag so tests can
 * assert the cleanup invariants.
 */
function harness<T>(options?: {
  maxQueued?: number;
  coalesceKey?: (event: T) => string | undefined;
}) {
  let push: ((event: T) => void) | null = null;
  let unsubscribed = false;
  const handle = createEventQueue<T>((p) => {
    push = p;
    return () => {
      unsubscribed = true;
    };
  }, options);
  return {
    ...handle,
    push: (event: T) => push!(event),
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

describe('createEventQueue', () => {
  it('subscribes synchronously so events pushed before any wait are buffered in order', () => {
    const h = harness<number>();
    h.push(1);
    h.push(2);
    h.push(3);
    expect(h.queue).toEqual([1, 2, 3]);
  });

  it('resolves waitForEvent when an event arrives', async () => {
    const h = harness<string>();
    const wait = h.waitForEvent(undefined);
    h.push('hello');
    await expect(wait).resolves.toBeUndefined();
    expect(h.queue).toEqual(['hello']);
  });

  it('resolves waitForEvent when the signal aborts, leaving the queue empty', async () => {
    const h = harness<number>();
    const controller = new AbortController();
    const wait = h.waitForEvent(controller.signal);
    controller.abort();
    await expect(wait).resolves.toBeUndefined();
    expect(h.queue).toEqual([]);
  });

  it('resolves waitForEvent synchronously when the signal is already aborted', async () => {
    // Regression guard: the 'abort' event has already fired and will not fire
    // again, so waiting on it would hang the subscription generator forever.
    const h = harness<number>();
    const controller = new AbortController();
    controller.abort();
    await expect(h.waitForEvent(controller.signal)).resolves.toBeUndefined();
  });

  it('removes the abort listener when an event (not the abort) ends the wait', async () => {
    const h = harness<number>();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const wait = h.waitForEvent(controller.signal);
    h.push(42);
    await wait;
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('supports repeated waits, resolving each on its own event', async () => {
    const h = harness<number>();

    const first = h.waitForEvent(undefined);
    h.push(1);
    await first;
    expect(h.queue.shift()).toBe(1);

    const second = h.waitForEvent(undefined);
    h.push(2);
    await second;
    expect(h.queue.shift()).toBe(2);
  });

  it('reports no overflow while under the cap', () => {
    const h = harness<number>({ maxQueued: 2 });
    h.push(1);
    h.push(2);
    expect(h.takeOverflow()).toBe(false);
    expect(h.queue).toEqual([1, 2]);
  });

  it('drops the buffer and flags overflow once when the cap is exceeded', () => {
    const h = harness<number>({ maxQueued: 2 });
    h.push(1);
    h.push(2);
    h.push(3);
    expect(h.queue).toEqual([]);
    expect(h.takeOverflow()).toBe(true);
    expect(h.takeOverflow()).toBe(false);
  });

  it('discards events that arrive between the overflow and the resync', () => {
    // Anything pushed before the consumer resyncs is covered by that resync, so
    // buffering it would only re-grow the queue while the consumer is stalled.
    const h = harness<number>({ maxQueued: 1 });
    h.push(1);
    h.push(2);
    h.push(3);
    expect(h.queue).toEqual([]);
    expect(h.takeOverflow()).toBe(true);
  });

  it('resumes buffering after the overflow is taken', () => {
    const h = harness<number>({ maxQueued: 1 });
    h.push(1);
    h.push(2);
    h.takeOverflow();
    h.push(3);
    expect(h.queue).toEqual([3]);
    expect(h.takeOverflow()).toBe(false);
  });

  it('wakes a waiting consumer on overflow so it can resync promptly', async () => {
    const h = harness<number>({ maxQueued: 1 });
    h.push(1);
    const wait = h.waitForEvent(undefined);
    h.push(2);
    await expect(wait).resolves.toBeUndefined();
    expect(h.takeOverflow()).toBe(true);
  });

  describe('coalescing', () => {
    type Ev = { id: string; partial: boolean; n: number };
    const coalesceKey = (e: Ev) => (e.partial ? e.id : undefined);

    it('drops a buffered event with the same key and appends its replacement', () => {
      const h = harness<Ev>({ coalesceKey });
      h.push({ id: 'p1', partial: true, n: 1 });
      h.push({ id: 'c1', partial: false, n: 2 });
      h.push({ id: 'p1', partial: true, n: 3 });
      expect(h.queue).toEqual([
        { id: 'c1', partial: false, n: 2 },
        { id: 'p1', partial: true, n: 3 },
      ]);
    });

    it('does not count superseded events toward the cap', () => {
      const h = harness<Ev>({ maxQueued: 2, coalesceKey });
      for (let n = 0; n < 10; n++) h.push({ id: 'p1', partial: true, n });
      h.push({ id: 'c1', partial: false, n: 10 });
      expect(h.queue).toHaveLength(2);
      expect(h.takeOverflow()).toBe(false);
    });

    it('never coalesces events without a key', () => {
      const h = harness<Ev>({ coalesceKey });
      h.push({ id: 'c1', partial: false, n: 1 });
      h.push({ id: 'c1', partial: false, n: 2 });
      expect(h.queue).toHaveLength(2);
    });
  });

  it('unsubscribe invokes the underlying subscription cleanup', () => {
    const h = harness<number>();
    expect(h.unsubscribed).toBe(false);
    h.unsubscribe();
    expect(h.unsubscribed).toBe(true);
  });
});

describe('sessionEventCoalesceKey', () => {
  const message = (id: string): ParsedMessage => ({
    id,
    sessionId: 's1',
    sequence: 0,
    type: 'assistant',
    content: {},
    createdAt: new Date(0),
  });
  const usage = (resultCount: number) =>
    buildTokenUsageStats({ ...EMPTY_SESSION_USAGE_TOTALS, resultCount });

  it('keeps only the newest of each latest-value kind and each partial stream, never deltas', () => {
    const h = harness<SessionStreamEvent>({ coalesceKey: sessionEventCoalesceKey });
    const main = partialMessageId(null);
    const sub = partialMessageId('toolu_1');
    h.push({ kind: 'running', running: true });
    h.push({ kind: 'token_usage', usage: usage(1) });
    h.push({ kind: 'message', message: message(main) });
    h.push({ kind: 'message', message: message(sub) });
    h.push({ kind: 'message', message: message('a') });
    h.push({ kind: 'message_removed', messageId: 'x' });
    h.push({ kind: 'message', message: message('b') });
    h.push({ kind: 'message_removed', messageId: 'y' });
    h.push({ kind: 'running', running: false });
    h.push({ kind: 'token_usage', usage: usage(2) });
    h.push({ kind: 'message', message: message(main) });

    expect(h.queue).toEqual([
      { kind: 'message', message: message(sub) },
      { kind: 'message', message: message('a') },
      { kind: 'message_removed', messageId: 'x' },
      { kind: 'message', message: message('b') },
      { kind: 'message_removed', messageId: 'y' },
      { kind: 'running', running: false },
      { kind: 'token_usage', usage: usage(2) },
      { kind: 'message', message: message(main) },
    ]);
  });

  it('coalesces every latest-value kind by kind alone', () => {
    const latestValue: SessionStreamEvent[] = [
      { kind: 'running', running: true },
      { kind: 'commands', commands: [] },
      { kind: 'retry', retry: null },
      { kind: 'background', tasks: [] },
      { kind: 'pending', messageIds: [] },
      { kind: 'queued', messageIds: [] },
      { kind: 'rate_limit', hold: null },
      { kind: 'token_usage', usage: usage(0) },
    ];
    for (const event of latestValue) expect(sessionEventCoalesceKey(event)).toBe(event.kind);
    // A complete message's id can never collide with a kind's key.
    expect(sessionEventCoalesceKey({ kind: 'message', message: message('running') })).toBe(
      undefined
    );
  });
});

describe('isStreamedSessionEvent', () => {
  const message = (id: string, type: string, content: unknown): SessionStreamEvent => ({
    kind: 'message',
    message: { id, sessionId: 's1', sequence: 0, type, content, createdAt: new Date(0) },
  });

  it('drops persisted messages no client reads', () => {
    expect(isStreamedSessionEvent(message('a', 'system', { subtype: 'init' }))).toBe(false);
    expect(
      isStreamedSessionEvent(
        message('b', 'assistant', { message: { content: [{ type: 'thinking', thinking: '' }] } })
      )
    ).toBe(false);
  });

  it('sends rows and their context', () => {
    expect(isStreamedSessionEvent(message('a', 'user', { content: 'hi' }))).toBe(true);
    expect(
      isStreamedSessionEvent(
        message('b', 'user', { message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } })
      )
    ).toBe(true);
    expect(isStreamedSessionEvent(message('c', 'system', { subtype: 'task_started' }))).toBe(true);
  });

  it('always sends partials and non-message events', () => {
    const emptyPartial = { message: { content: [{ type: 'thinking', thinking: '' }] } };
    expect(isStreamedSessionEvent(message(partialMessageId(null), 'assistant', emptyPartial))).toBe(
      true
    );
    expect(isStreamedSessionEvent({ kind: 'message_removed', messageId: 'a' })).toBe(true);
    expect(isStreamedSessionEvent({ kind: 'running', running: true })).toBe(true);
  });
});
