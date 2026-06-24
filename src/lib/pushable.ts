/**
 * A pushable async iterable: a queue you can `push()` values onto and `close()`,
 * consumed as an `AsyncIterable`.
 *
 * Unlike a generator that returns at end of input, the iterator **awaits when the
 * queue is empty** rather than returning, so the consumer stays open until
 * `close()` is called. This is what keeps a streaming Claude `query()` alive while
 * it sits idle between turns (the SDK consumes this as its `prompt`), so background
 * tasks survive and their notifications keep flowing into the same stream.
 *
 * Single-consumer: intended to be iterated exactly once.
 */
export interface Pushable<T> {
  /** The async iterable to hand to the consumer (e.g. the SDK `prompt`). */
  readonly iterable: AsyncIterable<T>;
  /** Enqueue a value for the consumer. No-op after {@link close}. */
  push(value: T): void;
  /** Signal end-of-input; iteration ends once the already-queued items drain. */
  close(): void;
  /** Whether {@link close} has been called. */
  readonly closed: boolean;
}

export function createPushable<T>(): Pushable<T> {
  const queue: T[] = [];
  let resolveNext: (() => void) | null = null;
  let isClosed = false;

  // Wake a parked consumer (if any). Idempotent: clears the waiter first so a
  // second wake before the consumer re-parks is a no-op.
  const wake = (): void => {
    const resolve = resolveNext;
    resolveNext = null;
    resolve?.();
  };

  const iterable: AsyncIterable<T> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        // Drain fully before honoring close, so queued items are never dropped.
        if (isClosed) return;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    },
  };

  return {
    iterable,
    push(value: T): void {
      if (isClosed) return;
      queue.push(value);
      wake();
    },
    close(): void {
      if (isClosed) return;
      isClosed = true;
      wake();
    },
    get closed(): boolean {
      return isClosed;
    },
  };
}
