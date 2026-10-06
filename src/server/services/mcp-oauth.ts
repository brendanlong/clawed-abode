import { randomBytes } from 'crypto';
import { TRPCError } from '@trpc/server';
import {
  exchangeAuthorization,
  refreshAuthorization,
  startAuthorization,
  type AddClientAuthentication,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { InvalidGrantError, OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { prisma } from '@/lib/prisma';
import { decrypt, encrypt } from '@/lib/crypto';
import { createLogger, toError } from '@/lib/logger';
import { isAccessTokenFresh, isFlowExpired, mcpOAuthRedirectUri } from '@/lib/mcp-oauth-urls';
import type { McpOAuthStatus, ResolvedMcpServer } from '@/lib/settings-types';
import {
  discoverMcpOAuth,
  fetchWithTimeout,
  registerOAuthClient,
  type DiscoveredOAuthConfig,
} from './mcp-oauth-discovery';

const log = createLogger('mcp-oauth');

const CLEARED_TOKENS = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
  authorizedAt: null,
};
const CLEARED_FLOW = { flowState: null, codeVerifier: null, flowStartedAt: null };

// ─── Token endpoint ──────────────────────────────────────────────────

const tokenFetch = fetchWithTimeout(30_000);

/**
 * Options shared by the SDK's code exchange and refresh. The hook replaces the
 * SDK's client authentication and its `resource` handling:
 * - credentials go as `client_secret_post`, not the SDK's default Basic header;
 * - `resource` is the exact stored string (the SDK sends `new URL(r).href`,
 *   which turns `https://host` into `https://host/` and breaks exact matching);
 * - `scope` is resent on refresh, which some servers (Entra) require.
 */
function tokenRequestOptions(
  grant: { clientSecret: string | null; resource: string | null; scope: string | null },
  tokenEndpoint: string,
  clientId: string
) {
  const clientSecret = grant.clientSecret ? decrypt(grant.clientSecret) : null;
  const addClientAuthentication: AddClientAuthentication = (_headers, params) => {
    params.set('client_id', clientId);
    if (clientSecret) params.set('client_secret', clientSecret);
    if (grant.resource) params.set('resource', grant.resource);
    if (grant.scope && params.get('grant_type') === 'refresh_token') {
      params.set('scope', grant.scope);
    }
  };
  return {
    // A token request reads only `token_endpoint` from the metadata.
    metadata: {
      issuer: tokenEndpoint,
      authorization_endpoint: tokenEndpoint,
      token_endpoint: tokenEndpoint,
      response_types_supported: ['code'],
    },
    clientInformation: { client_id: clientId },
    addClientAuthentication,
    fetchFn: tokenFetch,
  };
}

function oauthErrorMessage(error: unknown): string {
  const message =
    error instanceof OAuthError
      ? `Token request failed: ${error.errorCode}${error.message ? `: ${error.message}` : ''}`
      : toError(error).message;
  return message.slice(0, 500);
}

function accessTokenExpiry(expiresIn: number | undefined, now: Date): Date | null {
  return expiresIn === undefined ? null : new Date(now.getTime() + expiresIn * 1000);
}

// ─── Authorization flow ──────────────────────────────────────────────

/**
 * Run discovery and client acquisition, stash the PKCE verifier against a fresh
 * `state`, and return the URL the user's browser must visit.
 *
 * When the existing client is reused, existing tokens are left alone, so
 * abandoning a re-authorization doesn't break a working connection. When a new
 * client has to be registered they are cleared instead: a refresh token minted
 * for the old `client_id` can only earn an `invalid_grant`.
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
  const { metadata } = discovered;
  const reusable =
    existing?.clientId && (existing.clientIdIsManual || existing.issuer === metadata.issuer);
  const client = reusable
    ? { clientId: existing.clientId!, encryptedSecret: existing.clientSecret }
    : await registerNewClient(discovered, redirectUri, scope);

  const state = randomBytes(32).toString('base64url');
  const { authorizationUrl, codeVerifier } = await startAuthorization(metadata.issuer, {
    metadata,
    clientInformation: { client_id: client.clientId },
    redirectUrl: redirectUri,
    scope: scope ?? undefined,
    state,
  });
  // Set here rather than via the SDK, which would normalize it (see tokenRequestOptions).
  authorizationUrl.searchParams.set('resource', discovered.resource);

  const flow = {
    issuer: metadata.issuer,
    tokenEndpoint: metadata.token_endpoint,
    resource: discovered.resource,
    scope,
    clientId: client.clientId,
    clientSecret: client.encryptedSecret,
    flowState: state,
    codeVerifier: encrypt(codeVerifier),
    redirectUri,
    flowStartedAt: new Date(),
    lastError: null,
    ...(reusable ? {} : CLEARED_TOKENS),
  };

  await prisma.mcpOAuth.upsert({
    where: { mcpServerId: params.mcpServerId },
    create: { mcpServerId: params.mcpServerId, ...flow },
    update: flow,
  });

  log.info('Started MCP OAuth flow', {
    mcpServerId: params.mcpServerId,
    issuer: metadata.issuer,
    registered: !reusable,
  });

  return { authorizeUrl: authorizationUrl.toString() };
}

async function registerNewClient(
  discovered: DiscoveredOAuthConfig,
  redirectUri: string,
  scope: string | null
): Promise<{ clientId: string; encryptedSecret: string | null }> {
  if (!discovered.metadata.registration_endpoint) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'This server does not support dynamic client registration. Register an OAuth client ' +
        `with redirect URI ${redirectUri} and enter its client ID in the server's settings.`,
    });
  }
  const registered = await registerOAuthClient({
    metadata: discovered.metadata,
    redirectUri,
    scope,
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
  // Claim the state before spending the code, so a callback delivered twice can't
  // run two exchanges and have the loser overwrite the winner's result.
  const claimed = await prisma.mcpOAuth.updateMany({
    where: { id: row.id, flowState: params.state },
    data: { flowState: null },
  });
  if (claimed.count !== 1) {
    throw new Error('No pending authorization matches this callback');
  }
  if (isFlowExpired(row.flowStartedAt, new Date())) {
    await clearFlow(row.id, 'Authorization timed out; start it again');
    throw new Error('This authorization took too long and expired. Start it again.');
  }
  if (!row.tokenEndpoint || !row.clientId || !row.codeVerifier || !row.redirectUri) {
    await clearFlow(row.id, 'Pending authorization was incomplete');
    throw new Error('Pending authorization was incomplete. Start it again.');
  }

  try {
    const tokens = await exchangeAuthorization(row.tokenEndpoint, {
      ...tokenRequestOptions(row, row.tokenEndpoint, row.clientId),
      authorizationCode: params.code,
      codeVerifier: decrypt(row.codeVerifier),
      redirectUri: row.redirectUri,
    });

    await prisma.mcpOAuth.update({
      where: { id: row.id },
      data: {
        accessToken: encrypt(tokens.access_token),
        refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        expiresAt: accessTokenExpiry(tokens.expires_in, new Date()),
        scope: tokens.scope ?? row.scope,
        authorizedAt: new Date(),
        lastError: null,
        ...CLEARED_FLOW,
      },
    });
    log.info('Completed MCP OAuth flow', { mcpServerId: row.mcpServerId });
    return { serverName: row.mcpServer.name };
  } catch (error) {
    const message = oauthErrorMessage(error);
    await clearFlow(row.id, message);
    throw new Error(message, { cause: error });
  }
}

/** Discard a pending authorization the user declined or abandoned at the consent screen. */
export async function abandonMcpOAuthFlow(state: string, reason: string): Promise<void> {
  const row = await prisma.mcpOAuth.findUnique({ where: { flowState: state } });
  if (row) await clearFlow(row.id, reason);
}

async function clearFlow(id: string, lastError: string | null): Promise<void> {
  await prisma.mcpOAuth.update({
    where: { id },
    data: { ...CLEARED_FLOW, lastError },
  });
}

/**
 * Drop the tokens of a stored server whose URL is about to become `newUrl`, since
 * a grant is issued for one resource. Decided in the statement, so it needs no
 * read of the old URL; call it before writing the new one.
 */
export async function invalidateMcpOAuthOnUrlChange(
  server: { repoSettingsId: string | null; name: string },
  newUrl: string | null
): Promise<void> {
  await prisma.mcpOAuth.updateMany({
    where: { mcpServer: { ...server, OR: [{ url: null }, { url: { not: newUrl } }] } },
    data: { ...CLEARED_TOKENS, lastError: null },
  });
}

/**
 * Persist the OAuth client configuration a user typed into the server form, and
 * keep the grant consistent with it: switching a server away from OAuth (or to a
 * different client) invalidates any token we hold.
 */
export async function syncMcpOAuthConfig(params: {
  mcpServerId: string;
  isOAuth: boolean;
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
  // A blank field is only a deliberate "clear" for a client the user typed; for a
  // dynamically registered one it just means the form had nothing to show.
  const clearingManualClient = !clientId && !!existing?.clientIdIsManual;
  const client = clientId
    ? { clientId, clientIdIsManual: true }
    : clearingManualClient
      ? { clientId: null, clientIdIsManual: false }
      : {};

  const clientSecret = clearingManualClient
    ? null
    : params.clientSecret
      ? encrypt(params.clientSecret)
      : (existing?.clientSecret ?? null);

  // Tokens are bound to both the resource and the client they were issued for, so
  // either changing means what we hold can no longer work.
  const clientChanged = clientId !== null && clientId !== existing?.clientId;
  const invalidated =
    clientChanged || clearingManualClient ? { ...CLEARED_TOKENS, lastError: null } : {};

  const config = {
    scope: params.scope.trim() || null,
    clientSecret,
    ...client,
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
    data: { ...CLEARED_TOKENS, ...CLEARED_FLOW, lastError: null },
  });
  log.info('Disconnected MCP OAuth grant', { mcpServerId });
}

// ─── Access tokens for a query ───────────────────────────────────────

/** The token columns of a grant, carried alongside the server row it belongs to. */
export interface McpOAuthTokenSnapshot {
  id: string;
  /** Still encrypted — decrypted only when it is about to be used. */
  accessToken: string | null;
  expiresAt: Date | null;
}

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
    // Expired with no way to refresh (the server issued no refresh token). Report
    // it rather than handing back a token that can only produce a 401 the user
    // would see as "connected but nothing works".
    const lastError = row.accessToken
      ? 'Access token expired and the server issued no refresh token — connect again'
      : 'Not authorized — connect to sign in';
    await prisma.mcpOAuth.update({
      where: { id: oauthId },
      data: { accessToken: null, lastError },
    });
    return null;
  }

  try {
    const tokens = await refreshAuthorization(row.tokenEndpoint, {
      ...tokenRequestOptions(row, row.tokenEndpoint, row.clientId),
      refreshToken: decrypt(row.refreshToken),
    });
    await prisma.mcpOAuth.update({
      where: { id: oauthId },
      data: {
        accessToken: encrypt(tokens.access_token),
        // The SDK hands back the old refresh token when the server didn't rotate it.
        ...(tokens.refresh_token ? { refreshToken: encrypt(tokens.refresh_token) } : {}),
        expiresAt: accessTokenExpiry(tokens.expires_in, new Date()),
        lastError: null,
      },
    });
    return tokens.access_token;
  } catch (error) {
    const message = oauthErrorMessage(error);
    // A rejected grant is dead: drop the tokens so the UI shows "needs re-auth"
    // instead of retrying a refresh that can never succeed. Anything else
    // (network, 5xx) is transient and keeps the tokens for the next attempt.
    await prisma.mcpOAuth.update({
      where: { id: oauthId },
      data:
        error instanceof InvalidGrantError
          ? { ...CLEARED_TOKENS, lastError: message }
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
      if (server.type === 'stdio' || !server.oauth) return server;
      const { oauth, ...rest } = server;
      // The snapshot came with the server row, so an unexpired token costs no query.
      const token =
        oauth.accessToken && isAccessTokenFresh(oauth.expiresAt, new Date())
          ? decrypt(oauth.accessToken)
          : await ensureMcpAccessToken(oauth.id).catch((error) => {
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
