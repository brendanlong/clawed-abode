import { describe, it, expect } from 'vitest';
import { isTrackedEnvelope } from '@trpc/server';
import { eventStream } from './sse';

/** Unwrap a tracked envelope yielded by eventStream into [id, data]. */
function unwrap<T>(value: unknown): [string, T] {
  if (!isTrackedEnvelope(value)) {
    throw new Error('expected a tracked envelope');
  }
  return value as [string, T];
}

/**
 * Drive eventStream with a controllable emitter. Returns the generator plus a
 * `push` that feeds it and an `unsubscribed` flag so tests can assert cleanup.
 */
function harness<T>(opts?: { makeId?: (event: T, index: number) => string }) {
  let push: ((event: T) => void) | null = null;
  let unsubscribed = false;
  const controller = new AbortController();

  const gen = eventStream<T>(
    controller.signal,
    (p) => {
      push = p;
      return () => {
        unsubscribed = true;
      };
    },
    opts?.makeId ?? ((_event, index) => `id-${index}`)
  );

  return {
    gen,
    push: (event: T) => push!(event),
    abort: () => controller.abort(),
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

describe('eventStream', () => {
  it('yields pushed events in order, tagged by makeId', async () => {
    const h = harness<{ n: number }>();

    // The generator registers the listener on first pull, then awaits an event.
    const first = h.gen.next();
    h.push({ n: 1 });
    const [id1, data1] = unwrap<{ n: number }>((await first).value);
    expect(id1).toBe('id-0');
    expect(data1).toEqual({ n: 1 });

    const second = h.gen.next();
    h.push({ n: 2 });
    const [id2, data2] = unwrap<{ n: number }>((await second).value);
    expect(id2).toBe('id-1');
    expect(data2).toEqual({ n: 2 });
  });

  it('buffers events that arrive while the consumer is between pulls', async () => {
    const h = harness<number>();

    // Prime registration, then emit two events before pulling again.
    const firstPull = h.gen.next();
    h.push(10);
    await firstPull; // drains the first
    h.push(20);
    h.push(30);

    const [, a] = unwrap<number>((await h.gen.next()).value);
    const [, b] = unwrap<number>((await h.gen.next()).value);
    expect([a, b]).toEqual([20, 30]);
  });

  it('runs the prelude (catch-up) before live events, preserving its ids', async () => {
    const controller = new AbortController();
    let push: ((event: string) => void) | null = null;

    const gen = eventStream<string>(
      controller.signal,
      (p) => {
        push = p;
        return () => {};
      },
      (_event, index) => `live-${index}`,
      async function* () {
        yield { id: 'catchup-a', data: 'a' };
        yield { id: 'catchup-b', data: 'b' };
      }
    );

    // Listener registers before the prelude runs, so an event emitted during
    // catch-up is not lost — it is delivered after the prelude drains.
    const p1 = gen.next();
    push!('live');
    const [id1, d1] = unwrap<string>((await p1).value);
    expect([id1, d1]).toEqual(['catchup-a', 'a']);

    const [id2, d2] = unwrap<string>((await gen.next()).value);
    expect([id2, d2]).toEqual(['catchup-b', 'b']);

    const [id3, d3] = unwrap<string>((await gen.next()).value);
    expect([id3, d3]).toEqual(['live-0', 'live']);
  });

  it('unsubscribes and completes when the signal aborts', async () => {
    const h = harness<number>();

    const pending = h.gen.next(); // registers + waits
    h.abort();
    const result = await pending;

    expect(result.done).toBe(true);
    expect(h.unsubscribed).toBe(true);
  });

  it('unsubscribes when the consumer stops early (generator return)', async () => {
    const h = harness<number>();

    const firstPull = h.gen.next();
    h.push(1);
    await firstPull;

    await h.gen.return(undefined);
    expect(h.unsubscribed).toBe(true);
  });
});
