/**
 * Serialize an async job so at most one run is in flight and at most one more is
 * queued behind it. A call made while a run is in flight doesn't start a second
 * concurrent run; it shares a single follow-up that starts the moment the current
 * run settles (however it settles). So N requests during a run cost exactly one
 * more run, and every caller's promise settles only after a run that began after
 * their call — awaiting it means "my change has been acted on".
 *
 * For idempotent "recompute and converge" jobs.
 */
export function coalesce(run: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null;
  let followUp: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: unknown) => void;
  } | null = null;

  const start = (): Promise<void> => {
    const running = (async () => run())().finally(() => {
      current = null;
      const next = followUp;
      followUp = null;
      // Started synchronously, so no caller can slip a concurrent run in between.
      if (next) start().then(next.resolve, next.reject);
    });
    current = running;
    return running;
  };

  return () => {
    if (!current) return start();
    if (!followUp) {
      let resolve!: () => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      followUp = { promise, resolve, reject };
    }
    return followUp.promise;
  };
}
