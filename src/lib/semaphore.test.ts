import { describe, it, expect } from 'vitest';
import { Semaphore } from './semaphore';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Semaphore', () => {
  it('lets `limit` holders in at once and the rest in arrival order', async () => {
    const semaphore = new Semaphore(2);
    const order: number[] = [];
    const releases: (() => void)[] = [];
    for (let i = 0; i < 4; i++) {
      void semaphore.acquire().then((release) => {
        order.push(i);
        releases[i] = release;
      });
    }
    await settle();
    expect(order).toEqual([0, 1]);

    releases[1]();
    await settle();
    expect(order).toEqual([0, 1, 2]);
    releases[0]();
    await settle();
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('ignores a second release of the same slot', async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    release();
    release();
    const a = await semaphore.acquire();
    let second = false;
    void semaphore.acquire().then(() => (second = true));
    await settle();
    expect(second).toBe(false);
    a();
    await settle();
    expect(second).toBe(true);
  });
});
