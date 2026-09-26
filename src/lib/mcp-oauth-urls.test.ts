import { describe, it, expect } from 'vitest';
import {
  isAccessTokenFresh,
  isFlowExpired,
  isHttpUrl,
  mcpOAuthRedirectUri,
  OAUTH_FLOW_TTL_MS,
  TOKEN_EXPIRY_SKEW_MS,
} from './mcp-oauth-urls';

describe('isHttpUrl', () => {
  it('accepts only http(s)', () => {
    expect(isHttpUrl('https://as.example.com/authorize')).toBe(true);
    expect(isHttpUrl('http://127.0.0.1:8080/token')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});

describe('mcpOAuthRedirectUri', () => {
  it('appends the callback path to the app origin, tolerating a trailing slash', () => {
    expect(mcpOAuthRedirectUri('https://host.ts.net/')).toBe(
      'https://host.ts.net/api/mcp/oauth/callback'
    );
  });
});

describe('isAccessTokenFresh', () => {
  const now = new Date('2026-09-07T12:00:00Z');

  it('treats a token with no expiry as fresh', () => {
    expect(isAccessTokenFresh(null, now)).toBe(true);
  });

  it('refreshes inside the skew window rather than at the moment of expiry', () => {
    expect(isAccessTokenFresh(new Date(now.getTime() + TOKEN_EXPIRY_SKEW_MS + 1000), now)).toBe(
      true
    );
    expect(isAccessTokenFresh(new Date(now.getTime() + TOKEN_EXPIRY_SKEW_MS - 1000), now)).toBe(
      false
    );
    expect(isAccessTokenFresh(new Date(now.getTime() - 1), now)).toBe(false);
  });
});

describe('isFlowExpired', () => {
  const now = new Date('2026-09-07T12:00:00Z');

  it('expires a flow that was never started', () => {
    expect(isFlowExpired(null, now)).toBe(true);
  });

  it('expires only after the TTL', () => {
    expect(isFlowExpired(new Date(now.getTime() - OAUTH_FLOW_TTL_MS + 1000), now)).toBe(false);
    expect(isFlowExpired(new Date(now.getTime() - OAUTH_FLOW_TTL_MS - 1000), now)).toBe(true);
  });
});
