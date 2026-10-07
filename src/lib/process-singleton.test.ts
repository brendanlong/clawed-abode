import { describe, it, expect, vi } from 'vitest';
import { processSingleton } from './process-singleton';

describe('processSingleton', () => {
  it('creates the value once per key', () => {
    const create = vi.fn(() => ({ count: 0 }));
    const first = processSingleton('test.once', create);
    first.count++;
    expect(processSingleton('test.once', create)).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
    expect(processSingleton('test.other', () => ({ count: 0 }))).not.toBe(first);
  });

  it('is shared by separately loaded copies of the calling module', async () => {
    const copyA = await import('./process-singleton');
    vi.resetModules();
    const copyB = await import('./process-singleton');
    expect(copyB).not.toBe(copyA);
    const value = copyA.processSingleton('test.copies', () => new Map<string, number>());
    expect(copyB.processSingleton('test.copies', () => new Map<string, number>())).toBe(value);
  });
});
