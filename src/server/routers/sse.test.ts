import { describe, it, expect, vi } from 'vitest';
import { createEventQueue } from './sse';

/**
 * Wire up a createEventQueue with a controllable fake subscription. Returns the
 * queue handle plus the captured `push` and an `unsubscribed` flag so tests can
 * assert the cleanup invariants.
 */
function harness<T>(maxQueued?: number) {
  let push: ((event: T) => void) | null = null;
  let unsubscribed = false;
  const handle = createEventQueue<T>((p) => {
    push = p;
    return () => {
      unsubscribed = true;
    };
  }, maxQueued);
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
    const h = harness<number>(2);
    h.push(1);
    h.push(2);
    expect(h.takeOverflow()).toBe(false);
    expect(h.queue).toEqual([1, 2]);
  });

  it('drops the buffer and flags overflow once when the cap is exceeded', () => {
    const h = harness<number>(2);
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
    const h = harness<number>(1);
    h.push(1);
    h.push(2);
    h.push(3);
    expect(h.queue).toEqual([]);
    expect(h.takeOverflow()).toBe(true);
  });

  it('resumes buffering after the overflow is taken', () => {
    const h = harness<number>(1);
    h.push(1);
    h.push(2);
    h.takeOverflow();
    h.push(3);
    expect(h.queue).toEqual([3]);
    expect(h.takeOverflow()).toBe(false);
  });

  it('wakes a waiting consumer on overflow so it can resync promptly', async () => {
    const h = harness<number>(1);
    h.push(1);
    const wait = h.waitForEvent(undefined);
    h.push(2);
    await expect(wait).resolves.toBeUndefined();
    expect(h.takeOverflow()).toBe(true);
  });

  it('unsubscribe invokes the underlying subscription cleanup', () => {
    const h = harness<number>();
    expect(h.unsubscribed).toBe(false);
    h.unsubscribe();
    expect(h.unsubscribed).toBe(true);
  });
});
