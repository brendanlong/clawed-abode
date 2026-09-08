import { describe, it, expect } from 'vitest';
import { originHeadersFrom, resolveAppOrigin } from './app-origin';

describe('resolveAppOrigin', () => {
  it('prefers APP_URL and reduces it to an origin', () => {
    expect(resolveAppOrigin('https://host.ts.net/app/', { host: 'localhost:3000' })).toBe(
      'https://host.ts.net'
    );
  });

  it('falls back to the request headers when APP_URL is unusable', () => {
    expect(resolveAppOrigin('not a url', { forwardedHost: 'host.ts.net' })).toBeNull();
    expect(resolveAppOrigin('   ', { forwardedHost: 'host.ts.net' })).toBe('https://host.ts.net');
  });

  it('uses the first hop of forwarded values, preferring the forwarded host', () => {
    expect(
      resolveAppOrigin(undefined, {
        forwardedProto: 'https, http',
        forwardedHost: 'host.ts.net, internal',
        host: 'internal:3000',
      })
    ).toBe('https://host.ts.net');
  });

  it('assumes https for a real host and http for loopback', () => {
    expect(resolveAppOrigin(undefined, { host: 'host.ts.net' })).toBe('https://host.ts.net');
    expect(resolveAppOrigin(undefined, { host: 'localhost:3000' })).toBe('http://localhost:3000');
    expect(resolveAppOrigin(undefined, { host: '127.0.0.1:3000' })).toBe('http://127.0.0.1:3000');
    expect(resolveAppOrigin(undefined, { host: '[::1]:3000' })).toBe('http://[::1]:3000');
  });

  it('returns null when there is nothing to derive an origin from', () => {
    expect(resolveAppOrigin(undefined, {})).toBeNull();
  });
});

describe('originHeadersFrom', () => {
  it('reads the proxy headers Tailscale Serve sets', () => {
    const headers = new Headers({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'host.ts.net',
      host: 'localhost:3000',
    });
    expect(originHeadersFrom(headers)).toEqual({
      forwardedProto: 'https',
      forwardedHost: 'host.ts.net',
      host: 'localhost:3000',
    });
  });
});
