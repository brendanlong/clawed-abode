import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { prisma } from '@/lib/prisma';
import { decrypt, encrypt } from '@/lib/crypto';
import { createLogger, toError } from '@/lib/logger';
import {
  buildAuthorizeUrl,
  isAccessTokenFresh,
  isFlowExpired,
  mcpOAuthRedirectUri,
} from '@/lib/mcp-oauth-urls';
import type { McpOAuthStatus, ResolvedMcpServer } from '@/lib/settings-types';
import { discoverMcpOAuth, registerOAuthClient, safeJsonParse } from './mcp-oauth-discovery';

const log = createLogger('mcp-oauth');

const TOKEN_TIMEOUT_MS = 30_000;

// ─── PKCE / state ────────────────────────────────────────────────────

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

export function codeChallengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

// ─── Token endpoint ──────────────────────────────────────────────────

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/**
 * RFC 6749 token request parameters. Client credentials go in the body
 * (`client_secret_post`) rather than an Authorization header: servers that
 * accept only one of the two overwhelmingly accept the body form, and a public
 * PKCE client has no secret to put in a header anyway.
 */
export function buildTokenRequestBody(params: {
  grant:
    | { type: 'authorization_code'; code: string; codeVerifier: string }
    | { type: 'refresh_token'; refreshToken: string };
  clientId: string;
  clientSecret?: string | null;
  redirectUri?: string | null;
  resource?: string | null;
  scope?: string | null;
}): URLSearchParams {
  const body = new URLSearchParams();
  if (params.grant.type === 'authorization_code') {
    body.set('grant_type', 'authorization_code');
    body.set('code', params.grant.code);
    body.set('code_verifier', params.grant.codeVerifier);
    if (params.redirectUri) body.set('redirect_uri', params.redirectUri);
  } else {
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', params.grant.refreshToken);
    if (params.scope) body.set('scope', params.scope);
  }
  body.set('client_id', params.clientId);
  if (params.clientSecret) body.set('client_secret', params.clientSecret);
  if (params.resource) body.set('resource', params.resource);
  return body;
}

/** An OAuth error the user has to fix by re-authorizing (RFC 6749 §5.2). */
export class OAuthGrantInvalidError extends Error {}

async function postTokenRequest(
  tokenEndpoint: string,
  body: URLSearchParams
): Promise<TokenResponse> {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    const parsed = safeJsonParse(text);
    const error = z
      .object({ error: z.string(), error_description: z.string().optional() })
      .safeParse(parsed);
    const detail = error.success
      ? `${error.data.error}${error.data.error_description ? `: ${error.data.error_description}` : ''}`
      : text.slice(0, 300);
    const message = `Token request failed (${response.status}): ${detail}`;
    if (error.success && error.data.error === 'invalid_grant') {
      throw new OAuthGrantInvalidError(message);
    }
    throw new Error(message);
  }

  const parsed = tokenResponseSchema.safeParse(safeJsonParse(text));
  if (!parsed.success) {
    throw new Error('Token endpoint returned no access_token');
  }
  return parsed.data;
}

export function accessTokenExpiry(expiresIn: number | undefined, now: Date): Date | null {
  return expiresIn === undefined ? null : new Date(now.getTime() + expiresIn * 1000);
}

// ─── Authorization flow ──────────────────────────────────────────────

/**
 * Run discovery and client acquisition, stash the PKCE verifier against a fresh
 * `state`, and return the URL the user's browser must visit. Existing tokens are
 * left alone until the callback succeeds, so abandoning a re-authorization
 * doesn't break a working connection.
 */
export async function startMcpOAuthFlow(params: {
  mcpServerId: string;
  url: string;
  appOrigin: string;
}): Promise<{ authorizeUrl: string }> {
  const existing = await prisma.mcpOAuth.findUnique({ where: { mcpServerId: params.mcpServerId } });
  const discovered = await discoverMcpOAuth(params.url);
  const scope = existing?.scope ?? discovered.scopesSupported?.join(' ') ?? null;
  const redirectUri = mcpOAuthRedirectUri(params.appOrigin);

  // Reuse a client the user entered by hand, or one we registered against this
  // same issuer; re-register only when the issuer moved or we have nothing.
  const reusable =
    existing?.clientId && (existing.clientIdIsManual || existing.issuer === discovered.issuer);
  const client = reusable
    ? { clientId: existing.clientId!, encryptedSecret: existing.clientSecret }
    : await registerNewClient(discovered, redirectUri, scope);

  const codeVerifier = generateCodeVerifier();
  const state = base64url(randomBytes(32));

  const flow = {
    issuer: discovered.issuer,
    authorizationEndpoint: discovered.authorizationEndpoint,
    tokenEndpoint: discovered.tokenEndpoint,
    registrationEndpoint: discovered.registrationEndpoint,
    resource: discovered.resource,
    scope,
    clientId: client.clientId,
    clientSecret: client.encryptedSecret,
    flowState: state,
    codeVerifier: encrypt(codeVerifier),
    redirectUri,
    flowStartedAt: new Date(),
    lastError: null,
  };

  await prisma.mcpOAuth.upsert({
    where: { mcpServerId: params.mcpServerId },
    create: { mcpServerId: params.mcpServerId, ...flow },
    update: flow,
  });

  log.info('Started MCP OAuth flow', {
    mcpServerId: params.mcpServerId,
    issuer: discovered.issuer,
    registered: !reusable,
  });

  return {
    authorizeUrl: buildAuthorizeUrl({
      authorizationEndpoint: discovered.authorizationEndpoint,
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge: codeChallengeFor(codeVerifier),
      scope,
      resource: discovered.resource,
    }),
  };
}

async function registerNewClient(
  discovered: Awaited<ReturnType<typeof discoverMcpOAuth>>,
  redirectUri: string,
  scope: string | null
): Promise<{ clientId: string; encryptedSecret: string | null }> {
  if (!discovered.registrationEndpoint) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'This server does not support dynamic client registration. Register an OAuth client ' +
        `with redirect URI ${redirectUri} and enter its client ID in the server's settings.`,
    });
  }
  const registered = await registerOAuthClient({
    registrationEndpoint: discovered.registrationEndpoint,
    redirectUri,
    scope,
    supportsPublicClient: discovered.supportsPublicClient,
  });
  return {
    clientId: registered.clientId,
    encryptedSecret: registered.clientSecret ? encrypt(registered.clientSecret) : null,
  };
}

/**
 * Finish the flow from the browser redirect. `state` is the callback's only
 * credential — it is a 256-bit random value scoped to one pending flow, and it
 * is consumed here so a replayed callback can't re-run the exchange.
 */
export async function completeMcpOAuthFlow(params: {
  state: string;
  code: string;
}): Promise<{ serverName: string }> {
  const row = await prisma.mcpOAuth.findUnique({
    where: { flowState: params.state },
    include: { mcpServer: { select: { name: true } } },
  });
  if (!row) {
    throw new Error('No pending authorization matches this callback');
  }
  if (isFlowExpired(row.flowStartedAt, new Date())) {
    await clearFlow(row.id, 'Authorization timed out; start it again');
    throw new Error('This authorization took too long and expired. Start it again.');
  }
  if (!row.tokenEndpoint || !row.clientId || !row.codeVerifier) {
    await clearFlow(row.id, 'Pending authorization was incomplete');
    throw new Error('Pending authorization was incomplete. Start it again.');
  }

  try {
    const tokens = await postTokenRequest(
      row.tokenEndpoint,
      buildTokenRequestBody({
        grant: {
          type: 'authorization_code',
          code: params.code,
          codeVerifier: decrypt(row.codeVerifier),
        },
        clientId: row.clientId,
        clientSecret: row.clientSecret ? decrypt(row.clientSecret) : null,
        redirectUri: row.redirectUri,
        resource: row.resource,
      })
    );

    await prisma.mcpOAuth.update({
      where: { id: row.id },
      data: {
        accessToken: encrypt(tokens.access_token),
        refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        expiresAt: accessTokenExpiry(tokens.expires_in, new Date()),
        scope: tokens.scope ?? row.scope,
        authorizedAt: new Date(),
        lastError: null,
        flowState: null,
        codeVerifier: null,
        flowStartedAt: null,
      },
    });
    log.info('Completed MCP OAuth flow', { mcpServerId: row.mcpServerId });
    return { serverName: row.mcpServer.name };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await clearFlow(row.id, message);
    throw error;
  }
}

async function clearFlow(id: string, lastError: string | null): Promise<void> {
  await prisma.mcpOAuth.update({
    where: { id },
    data: { flowState: null, codeVerifier: null, flowStartedAt: null, lastError },
  });
}

/**
 * Persist the OAuth client configuration a user typed into the server form, and
 * keep the grant consistent with it: switching a server away from OAuth (or to a
 * different remote URL) invalidates any token we hold, because the grant was
 * issued for the old resource.
 */
export async function syncMcpOAuthConfig(params: {
  mcpServerId: string;
  isOAuth: boolean;
  urlChanged: boolean;
  clientId: string;
  /** Blank means "unchanged" (the field is masked in the UI). */
  clientSecret: string;
  scope: string;
}): Promise<void> {
  if (!params.isOAuth) {
    await prisma.mcpOAuth.deleteMany({ where: { mcpServerId: params.mcpServerId } });
    return;
  }

  const existing = await prisma.mcpOAuth.findUnique({
    where: { mcpServerId: params.mcpServerId },
  });
  const clientId = params.clientId.trim() || null;
  const clientSecret = params.clientSecret
    ? encrypt(params.clientSecret)
    : (existing?.clientSecret ?? null);
  const invalidated = params.urlChanged
    ? { accessToken: null, refreshToken: null, expiresAt: null, authorizedAt: null }
    : {};

  const config = {
    scope: params.scope.trim() || null,
    ...(clientId
      ? { clientId, clientSecret, clientIdIsManual: true }
      : // Clearing a manual client ID drops back to discovery/DCR on the next connect.
        existing?.clientIdIsManual
        ? { clientId: null, clientSecret: null, clientIdIsManual: false }
        : {}),
    ...invalidated,
  };

  await prisma.mcpOAuth.upsert({
    where: { mcpServerId: params.mcpServerId },
    create: { mcpServerId: params.mcpServerId, ...config },
    update: config,
  });
}

export async function disconnectMcpOAuth(mcpServerId: string): Promise<void> {
  await prisma.mcpOAuth.updateMany({
    where: { mcpServerId },
    data: {
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      authorizedAt: null,
      flowState: null,
      codeVerifier: null,
      flowStartedAt: null,
      lastError: null,
    },
  });
  log.info('Disconnected MCP OAuth grant', { mcpServerId });
}

// ─── Access tokens for a query ───────────────────────────────────────

/**
 * Refreshes in flight, keyed by credential id. Several sessions can establish at
 * once and a rotating refresh token is single-use, so a concurrent second
 * refresh would invalidate the first one's result.
 */
const pendingRefreshes = new Map<string, Promise<string | null>>();

/**
 * The current access token for a stored grant, refreshing it when it is close to
 * expiry. Returns null when the grant is missing or needs the user to
 * re-authorize; callers leave the Authorization header off rather than failing
 * the whole session, so the UI's "needs re-auth" state is what the user acts on.
 */
export async function ensureMcpAccessToken(oauthId: string): Promise<string | null> {
  const inFlight = pendingRefreshes.get(oauthId);
  if (inFlight) return inFlight;

  const promise = resolveAccessToken(oauthId).finally(() => pendingRefreshes.delete(oauthId));
  pendingRefreshes.set(oauthId, promise);
  return promise;
}

async function resolveAccessToken(oauthId: string): Promise<string | null> {
  const row = await prisma.mcpOAuth.findUnique({ where: { id: oauthId } });
  if (!row) return null;

  if (row.accessToken && isAccessTokenFresh(row.expiresAt, new Date())) {
    return decrypt(row.accessToken);
  }
  if (!row.refreshToken || !row.tokenEndpoint || !row.clientId) {
    return row.accessToken ? decrypt(row.accessToken) : null;
  }

  try {
    const tokens = await postTokenRequest(
      row.tokenEndpoint,
      buildTokenRequestBody({
        grant: { type: 'refresh_token', refreshToken: decrypt(row.refreshToken) },
        clientId: row.clientId,
        clientSecret: row.clientSecret ? decrypt(row.clientSecret) : null,
        resource: row.resource,
        scope: row.scope,
      })
    );
    await prisma.mcpOAuth.update({
      where: { id: oauthId },
      data: {
        accessToken: encrypt(tokens.access_token),
        // Rotation: keep the old refresh token only when the server didn't issue one.
        ...(tokens.refresh_token ? { refreshToken: encrypt(tokens.refresh_token) } : {}),
        expiresAt: accessTokenExpiry(tokens.expires_in, new Date()),
        lastError: null,
      },
    });
    return tokens.access_token;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A rejected grant is dead: drop the tokens so the UI shows "needs re-auth"
    // instead of retrying a refresh that can never succeed. Anything else
    // (network, 5xx) is transient and keeps the tokens for the next attempt.
    await prisma.mcpOAuth.update({
      where: { id: oauthId },
      data:
        error instanceof OAuthGrantInvalidError
          ? {
              accessToken: null,
              refreshToken: null,
              expiresAt: null,
              authorizedAt: null,
              lastError: message,
            }
          : { lastError: message },
    });
    log.warn('MCP OAuth token refresh failed', { oauthId, error: message });
    return null;
  }
}

/**
 * Inject `Authorization: Bearer` into every OAuth-backed server in a resolved
 * list. Runs after global/per-repo merging so a server shadowed by a per-repo
 * entry doesn't spend a refresh, and the marker id never reaches the SDK config.
 */
export async function applyMcpOAuthHeaders(
  servers: ResolvedMcpServer[]
): Promise<ResolvedMcpServer[]> {
  return Promise.all(
    servers.map(async (server) => {
      if (server.type === 'stdio' || !server.oauthCredentialId) return server;
      const { oauthCredentialId, ...rest } = server;
      const token = await ensureMcpAccessToken(oauthCredentialId).catch((error) => {
        log.error('Failed to resolve MCP OAuth token', toError(error));
        return null;
      });
      if (!token) return rest;
      return { ...rest, headers: { ...rest.headers, Authorization: `Bearer ${token}` } };
    })
  );
}

// ─── Display ─────────────────────────────────────────────────────────

/** DB fields the UI's OAuth badge is derived from. */
export interface OAuthStatusRow {
  clientId: string | null;
  clientIdIsManual: boolean;
  scope: string | null;
  authorizedAt: Date | null;
  expiresAt: Date | null;
  refreshToken: string | null;
  accessToken: string | null;
  lastError: string | null;
}

export function formatOAuthStatus(row: OAuthStatusRow | null | undefined): McpOAuthStatus {
  if (!row) {
    return {
      state: 'disconnected',
      clientId: null,
      clientIdIsManual: false,
      scope: null,
      authorizedAt: null,
      error: null,
    };
  }
  const connected = !!(row.accessToken || row.refreshToken);
  return {
    state: connected ? 'connected' : row.lastError ? 'error' : 'disconnected',
    clientId: row.clientId,
    clientIdIsManual: row.clientIdIsManual,
    scope: row.scope,
    authorizedAt: row.authorizedAt,
    error: row.lastError,
  };
}
