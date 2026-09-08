import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

vi.mock('@/lib/logger', async () => (await import('@/test/mock-logger')).mockLoggerModule());

let oauth: typeof import('./mcp-oauth');
let scope: typeof import('./settings-scope');
let crypto: typeof import('@/lib/crypto');

const APP_ORIGIN = 'https://app.example.ts.net';
const REDIRECT_URI = `${APP_ORIGIN}/api/mcp/oauth/callback`;

/**
 * A remote MCP server that guards `/api/mcp` and hosts its own authorization
 * server, wired the way a spec-compliant one is: 401 + `WWW-Authenticate` with a
 * path-inserted `resource_metadata`, RFC 9728 + RFC 8414 documents, DCR, and a
 * PKCE-checking token endpoint. Running it for real is the only way to cover the
 * discovery chain, which is where remote servers actually differ.
 */
class FakeMcpAuthServer {
  server: Server;
  baseUrl = '';
  /** Authorization codes minted at /authorize, by code. */
  codes = new Map<string, { challenge: string; redirectUri: string }>();
  registrations: Array<Record<string, unknown>> = [];
  tokenRequests: Array<Record<string, string>> = [];
  issuedRefreshToken = 'refresh-1';
  accessTokenLifetimeSeconds: number | undefined = 3600;
  /** When set, the token endpoint rejects every request with this OAuth error. */
  tokenError: string | null = null;
  registrationEndpointEnabled = true;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve()))
    );
  }

  get mcpUrl(): string {
    return `${this.baseUrl}/api/mcp`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/mcp') {
      const authorization = req.headers.authorization;
      if (!authorization) {
        res.writeHead(401, {
          'www-authenticate': `Bearer realm="OAuth", resource_metadata="${this.baseUrl}/.well-known/oauth-protected-resource/api/mcp"`,
        });
        res.end();
        return;
      }
      json(200, { ok: true });
      return;
    }

    if (url.pathname === '/.well-known/oauth-protected-resource/api/mcp') {
      json(200, {
        resource: this.mcpUrl,
        authorization_servers: [`${this.baseUrl}/tenant`],
        scopes_supported: ['data:read'],
      });
      return;
    }

    if (url.pathname === '/.well-known/oauth-authorization-server/tenant') {
      json(200, {
        issuer: `${this.baseUrl}/tenant`,
        authorization_endpoint: `${this.baseUrl}/tenant/authorize`,
        token_endpoint: `${this.baseUrl}/tenant/token`,
        ...(this.registrationEndpointEnabled
          ? { registration_endpoint: `${this.baseUrl}/tenant/register` }
          : {}),
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      });
      return;
    }

    if (url.pathname === '/tenant/register') {
      this.registrations.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
      json(201, { client_id: 'registered-client', client_id_issued_at: 1 });
      return;
    }

    if (url.pathname === '/tenant/token') {
      const params = Object.fromEntries(new URLSearchParams(await readBody(req)));
      this.tokenRequests.push(params);
      if (this.tokenError) {
        json(400, { error: this.tokenError, error_description: 'nope' });
        return;
      }
      if (params.grant_type === 'authorization_code') {
        const minted = this.codes.get(params.code);
        if (!minted || minted.challenge !== oauth.codeChallengeFor(params.code_verifier)) {
          json(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
          return;
        }
        this.codes.delete(params.code);
      }
      json(200, {
        access_token: `access-${this.tokenRequests.length}`,
        refresh_token: this.issuedRefreshToken,
        expires_in: this.accessTokenLifetimeSeconds,
        scope: 'data:read',
      });
      return;
    }

    res.writeHead(404).end();
  }

  /** Stand in for the user's browser approving the request at /authorize. */
  approve(authorizeUrl: string): { state: string; code: string } {
    const url = new URL(authorizeUrl);
    const code = `code-${this.codes.size + 1}`;
    this.codes.set(code, {
      challenge: url.searchParams.get('code_challenge')!,
      redirectUri: url.searchParams.get('redirect_uri')!,
    });
    return { state: url.searchParams.get('state')!, code };
  }
}

function readBody(req: {
  on: (event: string, cb: (chunk?: Buffer) => void) => void;
}): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk!));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

let remote: FakeMcpAuthServer;

async function addOAuthServer(name = 'remote'): Promise<void> {
  await scope.upsertMcpServer(scope.GLOBAL_SCOPE, {
    name,
    type: 'http',
    url: remote.mcpUrl,
    authType: 'oauth',
  });
}

async function connect(name = 'remote'): Promise<void> {
  const { authorizeUrl } = await scope.startScopeMcpOAuth(scope.GLOBAL_SCOPE, name, APP_ORIGIN);
  const { state, code } = remote.approve(authorizeUrl);
  await oauth.completeMcpOAuthFlow({ state, code });
}

function credential(name = 'remote') {
  return testPrisma.mcpOAuth.findFirstOrThrow({ where: { mcpServer: { name } } });
}

describe('MCP OAuth', () => {
  beforeAll(async () => {
    await setupTestDb();
    oauth = await import('./mcp-oauth');
    scope = await import('./settings-scope');
    crypto = await import('@/lib/crypto');
    remote = new FakeMcpAuthServer();
    await remote.start();
  });

  afterAll(async () => {
    await remote.stop();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    remote.codes.clear();
    remote.registrations = [];
    remote.tokenRequests = [];
    remote.tokenError = null;
    remote.registrationEndpointEnabled = true;
    remote.issuedRefreshToken = 'refresh-1';
    remote.accessTokenLifetimeSeconds = 3600;
  });

  it('discovers, registers and authorizes, storing only ciphertext', async () => {
    await addOAuthServer();
    const { authorizeUrl } = await scope.startScopeMcpOAuth(
      scope.GLOBAL_SCOPE,
      'remote',
      APP_ORIGIN
    );

    expect(remote.registrations).toHaveLength(1);
    expect(remote.registrations[0]).toMatchObject({
      redirect_uris: [REDIRECT_URI],
      // The AS advertises "none", so a public PKCE client is what we ask for.
      token_endpoint_auth_method: 'none',
      scope: 'data:read',
    });

    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe(`${remote.baseUrl}/tenant/authorize`);
    expect(url.searchParams.get('client_id')).toBe('registered-client');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // RFC 8707: the token must be minted for the MCP endpoint, not the origin.
    expect(url.searchParams.get('resource')).toBe(remote.mcpUrl);
    expect(url.searchParams.get('scope')).toBe('data:read');

    const pending = await credential();
    expect(pending.flowState).toBe(url.searchParams.get('state'));
    expect(crypto.decrypt(pending.codeVerifier!)).toHaveLength(43);
    expect(oauth.codeChallengeFor(crypto.decrypt(pending.codeVerifier!))).toBe(
      url.searchParams.get('code_challenge')
    );

    const { state, code } = remote.approve(authorizeUrl);
    expect(await oauth.completeMcpOAuthFlow({ state, code })).toEqual({ serverName: 'remote' });

    const connected = await credential();
    expect(connected.accessToken).not.toContain('access-');
    expect(crypto.decrypt(connected.accessToken!)).toBe('access-1');
    expect(crypto.decrypt(connected.refreshToken!)).toBe('refresh-1');
    expect(connected.authorizedAt).not.toBeNull();
    expect(connected.lastError).toBeNull();
    // The flow is consumed, so a replayed callback has nothing to match.
    expect(connected.flowState).toBeNull();
    expect(connected.codeVerifier).toBeNull();
  });

  it('injects the access token as an Authorization header for a session', async () => {
    await addOAuthServer();
    await connect();

    const merger = await import('./settings-merger');
    const settings = await merger.loadMergedSessionSettings(null);
    expect(settings.mcpServers).toEqual([
      {
        name: 'remote',
        type: 'http',
        url: remote.mcpUrl,
        headers: { Authorization: 'Bearer access-1' },
      },
    ]);
  });

  it('refreshes an expired access token and follows refresh-token rotation', async () => {
    await addOAuthServer();
    await connect();
    await testPrisma.mcpOAuth.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    remote.issuedRefreshToken = 'refresh-2';

    const row = await credential();
    expect(await oauth.ensureMcpAccessToken(row.id)).toBe('access-2');
    expect(remote.tokenRequests.at(-1)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      resource: remote.mcpUrl,
    });

    const refreshed = await credential();
    expect(crypto.decrypt(refreshed.refreshToken!)).toBe('refresh-2');
    expect(refreshed.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('coalesces concurrent refreshes so a single-use refresh token is spent once', async () => {
    await addOAuthServer();
    await connect();
    await testPrisma.mcpOAuth.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const row = await credential();

    const tokens = await Promise.all([
      oauth.ensureMcpAccessToken(row.id),
      oauth.ensureMcpAccessToken(row.id),
      oauth.ensureMcpAccessToken(row.id),
    ]);
    expect(new Set(tokens).size).toBe(1);
    expect(remote.tokenRequests.filter((r) => r.grant_type === 'refresh_token')).toHaveLength(1);
  });

  it('drops a rejected grant so the UI asks for re-authorization', async () => {
    await addOAuthServer();
    await connect();
    await testPrisma.mcpOAuth.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    remote.tokenError = 'invalid_grant';

    const row = await credential();
    expect(await oauth.ensureMcpAccessToken(row.id)).toBeNull();

    const dead = await credential();
    expect(dead.accessToken).toBeNull();
    expect(dead.refreshToken).toBeNull();
    expect(oauth.formatOAuthStatus(dead).state).toBe('error');

    const { mcpServers } = await scope.listScopeSettings(scope.GLOBAL_SCOPE);
    expect(mcpServers[0].oauth).toMatchObject({ state: 'error' });
  });

  it('keeps the grant when a refresh fails for a transient reason', async () => {
    await addOAuthServer();
    await connect();
    await testPrisma.mcpOAuth.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    remote.tokenError = 'temporarily_unavailable';

    const row = await credential();
    expect(await oauth.ensureMcpAccessToken(row.id)).toBeNull();

    const kept = await credential();
    expect(crypto.decrypt(kept.refreshToken!)).toBe('refresh-1');
    expect(kept.lastError).toContain('temporarily_unavailable');
    expect(oauth.formatOAuthStatus(kept).state).toBe('connected');
  });

  it('reuses a registered client on re-authorization', async () => {
    await addOAuthServer();
    await connect();
    await connect();
    expect(remote.registrations).toHaveLength(1);
  });

  it('uses a manually entered client instead of registering one', async () => {
    await scope.upsertMcpServer(scope.GLOBAL_SCOPE, {
      name: 'remote',
      type: 'http',
      url: remote.mcpUrl,
      authType: 'oauth',
      oauth: { clientId: 'hand-made', clientSecret: 'sh', scope: 'data:read' },
    });

    const { authorizeUrl } = await scope.startScopeMcpOAuth(
      scope.GLOBAL_SCOPE,
      'remote',
      APP_ORIGIN
    );
    expect(remote.registrations).toHaveLength(0);
    expect(new URL(authorizeUrl).searchParams.get('client_id')).toBe('hand-made');

    const { state, code } = remote.approve(authorizeUrl);
    await oauth.completeMcpOAuthFlow({ state, code });
    expect(remote.tokenRequests.at(-1)).toMatchObject({
      client_id: 'hand-made',
      client_secret: 'sh',
    });

    const stored = await credential();
    expect(crypto.decrypt(stored.clientSecret!)).toBe('sh');
    // Re-saving the form with a blank secret keeps the stored one.
    await scope.upsertMcpServer(scope.GLOBAL_SCOPE, {
      name: 'remote',
      type: 'http',
      url: remote.mcpUrl,
      authType: 'oauth',
      oauth: { clientId: 'hand-made', clientSecret: '', scope: '' },
    });
    expect(crypto.decrypt((await credential()).clientSecret!)).toBe('sh');
  });

  it('points at the manual escape hatch when the server has no registration endpoint', async () => {
    remote.registrationEndpointEnabled = false;
    await addOAuthServer();
    await expect(
      scope.startScopeMcpOAuth(scope.GLOBAL_SCOPE, 'remote', APP_ORIGIN)
    ).rejects.toThrow(/does not support dynamic client registration/);
  });

  it('rejects a callback whose state matches no pending flow', async () => {
    await addOAuthServer();
    await expect(oauth.completeMcpOAuthFlow({ state: 'made-up', code: 'c' })).rejects.toThrow(
      /No pending authorization/
    );
  });

  it('rejects a callback after the flow has expired', async () => {
    await addOAuthServer();
    const { authorizeUrl } = await scope.startScopeMcpOAuth(
      scope.GLOBAL_SCOPE,
      'remote',
      APP_ORIGIN
    );
    const { state, code } = remote.approve(authorizeUrl);
    await testPrisma.mcpOAuth.updateMany({
      data: { flowStartedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    await expect(oauth.completeMcpOAuthFlow({ state, code })).rejects.toThrow(/expired/);
    expect((await credential()).flowState).toBeNull();
  });

  it('drops tokens when the server URL changes, since the grant was for the old resource', async () => {
    await addOAuthServer();
    await connect();
    await scope.upsertMcpServer(scope.GLOBAL_SCOPE, {
      name: 'remote',
      type: 'http',
      url: `${remote.baseUrl}/other/mcp`,
      authType: 'oauth',
    });

    const moved = await credential();
    expect(moved.accessToken).toBeNull();
    expect(moved.refreshToken).toBeNull();
  });

  it('deletes the grant when the server stops using OAuth, and on disconnect', async () => {
    await addOAuthServer();
    await connect();

    await scope.disconnectScopeMcpOAuth(scope.GLOBAL_SCOPE, 'remote');
    const disconnected = await credential();
    expect(disconnected.accessToken).toBeNull();
    expect(disconnected.refreshToken).toBeNull();
    // The client registration survives, so reconnecting doesn't re-register.
    expect(disconnected.clientId).toBe('registered-client');

    await scope.upsertMcpServer(scope.GLOBAL_SCOPE, {
      name: 'remote',
      type: 'http',
      url: remote.mcpUrl,
      authType: 'headers',
    });
    expect(await testPrisma.mcpOAuth.count()).toBe(0);
  });

  it('cascades the grant away with the server row', async () => {
    await addOAuthServer();
    await connect();
    await scope.deleteMcpServer(scope.GLOBAL_SCOPE, 'remote');
    expect(await testPrisma.mcpOAuth.count()).toBe(0);
  });
});
