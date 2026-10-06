import { describe, it, expect } from 'vitest';
import { coalesce } from './coalesce';

/** A job whose runs are released by hand, recording how many are in flight. */
function controlledJob() {
  const releases: Array<(err?: Error) => void> = [];
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const run = () => {
    runs++;
    active++;
    maxActive = Math.max(maxActive, active);
    return new Promise<void>((resolve, reject) => {
      releases.push((err) => {
        active--;
        if (err) reject(err);
        else resolve();
      });
    });
  };
  return {
    run,
    get runs() {
      return runs;
    },
    get maxActive() {
      return maxActive;
    },
    release: (err?: Error) => releases.shift()!(err),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('coalesce', () => {
  it('runs once for a single call', async () => {
    const job = controlledJob();
    const trigger = coalesce(job.run);
    const done = trigger();
    job.release();
    await done;
    expect(job.runs).toBe(1);
  });

  it('folds every call made during a run into one follow-up, never running concurrently', async () => {
    const job = controlledJob();
    const trigger = coalesce(job.run);
    const first = trigger();
    const a = trigger();
    const b = trigger();
    expect(a).toBe(b);
    expect(job.runs).toBe(1);

    job.release();
    await first;
    await flush();
    expect(job.runs).toBe(2);
    job.release();
    await Promise.all([a, b]);
    expect(job.runs).toBe(2);
    expect(job.maxActive).toBe(1);
  });

  it("settles a caller's promise only after a run that started after the call", async () => {
    const job = controlledJob();
    const trigger = coalesce(job.run);
    void trigger();
    let followUpDone = false;
    void trigger().then(() => (followUpDone = true));

    job.release();
    await flush();
    expect(followUpDone).toBe(false);
    job.release();
    await flush();
    expect(followUpDone).toBe(true);
  });

  it('still runs the follow-up when the current run fails, and surfaces each run’s own outcome', async () => {
    const job = controlledJob();
    const trigger = coalesce(job.run);
    const first = trigger();
    const second = trigger();

    job.release(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    await flush();
    expect(job.runs).toBe(2);
    job.release();
    await expect(second).resolves.toBeUndefined();
  });

  it('starts fresh once idle', async () => {
    const job = controlledJob();
    const trigger = coalesce(job.run);
    const first = trigger();
    job.release();
    await first;
    const next = trigger();
    expect(job.runs).toBe(2);
    job.release();
    await next;
  });

  it('a call from a run’s own continuation queues behind the follow-up instead of racing it', async () => {
    const job = controlledJob();
    const trigger = coalesce(job.run);
    const first = trigger();
    const followUp = trigger();
    let fromContinuation: Promise<void> | null = null;
    void first.then(() => {
      fromContinuation = trigger();
    });

    job.release();
    await flush();
    expect(job.maxActive).toBe(1);
    expect(fromContinuation).not.toBe(followUp);
    job.release();
    await followUp;
    await flush();
    job.release();
    await fromContinuation;
    expect(job.runs).toBe(3);
    expect(job.maxActive).toBe(1);
  });
});
