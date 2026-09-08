import { describe, it, expect } from 'vitest';
import {
  authorizationServerMetadataUrls,
  buildAuthorizeUrl,
  fallbackAuthorizationServerEndpoints,
  isAccessTokenFresh,
  isFlowExpired,
  mcpOAuthRedirectUri,
  parseWwwAuthenticate,
  protectedResourceMetadataUrls,
  OAUTH_FLOW_TTL_MS,
  TOKEN_EXPIRY_SKEW_MS,
} from './mcp-oauth-urls';

describe('parseWwwAuthenticate', () => {
  it('extracts quoted challenge parameters, ignoring the scheme', () => {
    expect(
      parseWwwAuthenticate(
        'Bearer realm="OAuth", resource_metadata="https://h/.well-known/oauth-protected-resource/api/mcp", error="invalid_token"'
      )
    ).toEqual({
      realm: 'OAuth',
      resource_metadata: 'https://h/.well-known/oauth-protected-resource/api/mcp',
      error: 'invalid_token',
    });
  });

  it('accepts unquoted values and a lowercase scheme', () => {
    expect(parseWwwAuthenticate('bearer error=invalid_token')).toEqual({ error: 'invalid_token' });
  });

  it('returns nothing for a missing or scheme-only header', () => {
    expect(parseWwwAuthenticate(null)).toEqual({});
    expect(parseWwwAuthenticate('Bearer')).toEqual({});
  });
});

describe('protectedResourceMetadataUrls', () => {
  // RFC 9728 §3.1: the well-known segment goes *before* the resource's path.
  it('tries the path-inserted location before the root one', () => {
    expect(protectedResourceMetadataUrls('https://ai.todoist.net/mcp')).toEqual([
      'https://ai.todoist.net/.well-known/oauth-protected-resource/mcp',
      'https://ai.todoist.net/.well-known/oauth-protected-resource',
    ]);
  });

  it('uses only the root location for a bare-origin resource', () => {
    expect(protectedResourceMetadataUrls('https://mcp.example.com/')).toEqual([
      'https://mcp.example.com/.well-known/oauth-protected-resource',
    ]);
  });
});

describe('authorizationServerMetadataUrls', () => {
  it('path-inserts for an issuer with a path, then falls back to OIDC layouts', () => {
    expect(authorizationServerMetadataUrls('https://auth.example.com/tenant1')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.com/.well-known/openid-configuration/tenant1',
      'https://auth.example.com/tenant1/.well-known/openid-configuration',
    ]);
  });

  it('uses the plain well-known locations for a bare issuer', () => {
    expect(authorizationServerMetadataUrls('https://todoist.com')).toEqual([
      'https://todoist.com/.well-known/oauth-authorization-server',
      'https://todoist.com/.well-known/openid-configuration',
    ]);
  });
});

describe('fallbackAuthorizationServerEndpoints', () => {
  it('synthesizes endpoints at the origin root, never under the resource path', () => {
    expect(fallbackAuthorizationServerEndpoints('https://h.example.com/api/mcp')).toEqual({
      issuer: 'https://h.example.com',
      authorizationEndpoint: 'https://h.example.com/authorize',
      tokenEndpoint: 'https://h.example.com/token',
      registrationEndpoint: 'https://h.example.com/register',
    });
  });
});

describe('buildAuthorizeUrl', () => {
  it('always sends PKCE and preserves query already on the endpoint', () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: 'https://as.example.com/authorize?tenant=a',
        clientId: 'client-1',
        redirectUri: 'https://app.ts.net/api/mcp/oauth/callback',
        state: 'st',
        codeChallenge: 'ch',
        scope: 'data:read',
        resource: 'https://ai.todoist.net/mcp',
      })
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tenant: 'a',
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: 'https://app.ts.net/api/mcp/oauth/callback',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      scope: 'data:read',
      resource: 'https://ai.todoist.net/mcp',
    });
  });

  it('omits scope and resource when they are unknown', () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: 'https://as.example.com/authorize',
        clientId: 'c',
        redirectUri: 'https://app/cb',
        state: 's',
        codeChallenge: 'ch',
        scope: null,
        resource: null,
      })
    );
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.has('resource')).toBe(false);
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
