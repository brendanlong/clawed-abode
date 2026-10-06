import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  PUBLIC_LOGIN_CODE_TTL_MS,
  consumePublicLoginCode,
  mintPublicLoginCode,
} from './public-login-codes';

afterEach(() => {
  vi.useRealTimers();
});

describe('public login codes', () => {
  it('can be consumed once', () => {
    const code = mintPublicLoginCode();
    expect(consumePublicLoginCode(code)).toBe(true);
    expect(consumePublicLoginCode(code)).toBe(false);
  });

  it('are unique', () => {
    expect(mintPublicLoginCode()).not.toBe(mintPublicLoginCode());
  });

  it('rejects unknown codes', () => {
    expect(consumePublicLoginCode('nope')).toBe(false);
  });

  it('expire', () => {
    vi.useFakeTimers();
    const code = mintPublicLoginCode();
    vi.advanceTimersByTime(PUBLIC_LOGIN_CODE_TTL_MS);
    expect(consumePublicLoginCode(code)).toBe(false);
  });
});
