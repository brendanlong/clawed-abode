import { describe, it, expect } from 'vitest';
import { createPushable } from './pushable';

/** Collect all values from an async iterable into an array. */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iterable) out.push(v);
  return out;
}

describe('createPushable', () => {
  it('yields queued values in order, then ends on close', async () => {
    const p = createPushable<number>();
    p.push(1);
    p.push(2);
    p.push(3);
    p.close();
    expect(await collect(p.iterable)).toEqual([1, 2, 3]);
  });

  it('awaits when empty and resumes on a later push', async () => {
    const p = createPushable<string>();
    const it = p.iterable[Symbol.asyncIterator]();
    const pending = it.next();

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    // Give microtasks a chance; nothing was pushed, so it must still be pending.
    await Promise.resolve();
    expect(settled).toBe(false);

    p.push('a');
    expect(await pending).toEqual({ value: 'a', done: false });
  });

  it('ends iteration when close() happens while the consumer is waiting', async () => {
    const p = createPushable<number>();
    const it = p.iterable[Symbol.asyncIterator]();
    const pending = it.next();
    p.close();
    expect(await pending).toEqual({ value: undefined, done: true });
  });

  it('drains already-queued items before honoring close', async () => {
    const p = createPushable<number>();
    p.push(1);
    p.push(2);
    p.close();
    // close after queueing must not drop the queued items.
    expect(await collect(p.iterable)).toEqual([1, 2]);
  });

  it('ignores push after close', async () => {
    const p = createPushable<number>();
    p.push(1);
    p.close();
    p.push(2); // ignored
    expect(await collect(p.iterable)).toEqual([1]);
  });

  it('reports closed state', () => {
    const p = createPushable<number>();
    expect(p.closed).toBe(false);
    p.close();
    expect(p.closed).toBe(true);
  });

  it('interleaves push and consume across awaits', async () => {
    const p = createPushable<number>();
    const it = p.iterable[Symbol.asyncIterator]();

    p.push(10);
    expect(await it.next()).toEqual({ value: 10, done: false });

    const pending = it.next(); // queue empty -> parks
    p.push(20);
    expect(await pending).toEqual({ value: 20, done: false });

    p.close();
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });
});
