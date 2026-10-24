/** Run jobs one at a time, in call order; a job's failure doesn't stop the ones after it. */
export function serialQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (job) => {
    const run = tail.then(job);
    tail = run.catch(() => undefined);
    return run;
  };
}
