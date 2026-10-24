import { describe, it, expect } from 'vitest';
import { serialQueue } from './serial-queue';

describe('serialQueue', () => {
  it('runs jobs one at a time in call order, past failures', async () => {
    const enqueue = serialQueue();
    const events: string[] = [];
    let release!: () => void;
    const first = enqueue(async () => {
      events.push('first start');
      await new Promise<void>((resolve) => (release = resolve));
      events.push('first end');
    });
    const failing = enqueue(async () => {
      events.push('failing');
      throw new Error('boom');
    });
    const last = enqueue(async () => {
      events.push('last');
      return 3;
    });

    await Promise.resolve();
    expect(events).toEqual(['first start']);
    release();
    await first;
    await expect(failing).rejects.toThrow('boom');
    expect(await last).toBe(3);
    expect(events).toEqual(['first start', 'first end', 'failing', 'last']);
  });
});
