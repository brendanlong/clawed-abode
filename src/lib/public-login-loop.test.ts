import { describe, it, expect } from 'vitest';
import { PUBLIC_LOGIN_RETRY_WINDOW_MS, claimAutomaticReturn } from './public-login-loop';

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

describe('claimAutomaticReturn', () => {
  it('allows the first return and refuses an immediate repeat to the same path', () => {
    const storage = memoryStorage();
    expect(claimAutomaticReturn(storage, '/a', 1000)).toBe(true);
    expect(claimAutomaticReturn(storage, '/a', 2000)).toBe(false);
  });

  it('allows a different path or a later retry', () => {
    const storage = memoryStorage();
    claimAutomaticReturn(storage, '/a', 1000);
    expect(claimAutomaticReturn(storage, '/b', 2000)).toBe(true);
    expect(claimAutomaticReturn(storage, '/b', 2000 + PUBLIC_LOGIN_RETRY_WINDOW_MS)).toBe(true);
  });

  it('ignores corrupt storage', () => {
    const storage = memoryStorage();
    storage.setItem('publicLoginAttempt', '{nope');
    expect(claimAutomaticReturn(storage, '/a', 1000)).toBe(true);
  });
});
