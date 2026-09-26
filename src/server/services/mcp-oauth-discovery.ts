import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
  registerClient,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  AuthorizationServerMetadata,
  OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createLogger, toError } from '@/lib/logger';
import { isHttpUrl } from '@/lib/mcp-oauth-urls';

const log = createLogger('mcp-oauth-discovery');

const OAUTH_TIMEOUT_MS = 30_000;

export const fetchWithTimeout: FetchLike = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS) });

export interface DiscoveredOAuthConfig {
  /** Real metadata, or origin-root endpoints synthesized when the server publishes none. */
  metadata: AuthorizationServerMetadata;
  /** RFC 8707 resource indicator to request tokens for. */
  resource: string;
  /** Scopes the resource accepts — the PRM's list, not the AS's broader one. */
  scopesSupported: string[] | null;
}

/**
 * Ask the MCP endpoint who guards it. A spec-compliant server answers an
 * unauthenticated request with 401 + `WWW-Authenticate: Bearer
 * resource_metadata="..."`; that pointer is authoritative.
 */
async function probeResourceMetadataUrl(mcpUrl: string): Promise<URL | undefined> {
  try {
    const response = await fetchWithTimeout(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    await response.body?.cancel();
    if (response.status !== 401) return undefined;
    return extractWWWAuthenticateParams(response).resourceMetadataUrl;
  } catch (error) {
    log.info('Unauthenticated probe of MCP endpoint failed', {
      mcpUrl,
      error: toError(error).message,
    });
    return undefined;
  }
}

async function discoverResourceMetadata(
  mcpUrl: string
): Promise<OAuthProtectedResourceMetadata | undefined> {
  // The SDK tries only the given URL when one is advertised, so a broken pointer
  // falls back to its own path-inserted-then-root well-known lookup.
  const advertised = await probeResourceMetadataUrl(mcpUrl);
  const attempts = advertised ? [{ resourceMetadataUrl: advertised }, {}] : [{}];
  for (const opts of attempts) {
    try {
      return await discoverOAuthProtectedResourceMetadata(mcpUrl, opts, fetchWithTimeout);
    } catch (error) {
      log.debug('Protected resource metadata lookup failed', {
        mcpUrl,
        error: toError(error).message,
      });
    }
  }
  return undefined;
}

/**
 * The SDK rejects only `javascript:`/`data:`/`vbscript:`; the authorization
 * endpoint ends up in `window.location.assign`, so allow http(s) and nothing else.
 */
function hasHttpEndpoints(metadata: AuthorizationServerMetadata): boolean {
  return [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ].every((url) => url === undefined || isHttpUrl(url));
}

async function discoverIssuerMetadata(
  issuer: string
): Promise<AuthorizationServerMetadata | undefined> {
  try {
    const metadata = await discoverAuthorizationServerMetadata(issuer, {
      fetchFn: fetchWithTimeout,
    });
    if (metadata && !hasHttpEndpoints(metadata)) {
      log.info('Ignoring metadata with non-http(s) endpoints', { issuer });
      return undefined;
    }
    return metadata;
  } catch (error) {
    log.info('Ignoring unusable authorization server metadata', {
      issuer,
      error: toError(error).message,
    });
    return undefined;
  }
}

/** What other MCP clients synthesize when nothing is published: the origin root, never the resource's path. */
function originRootMetadata(mcpUrl: string): AuthorizationServerMetadata {
  const { origin } = new URL(mcpUrl);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ['code'],
  };
}

/**
 * Resolve everything needed to run an authorization-code flow against a remote
 * MCP server, degrading one step at a time: the advertised metadata pointer,
 * then the well-known locations, then the origin-root endpoints. Only a server
 * that publishes nothing anywhere fails.
 */
export async function discoverMcpOAuth(mcpUrl: string): Promise<DiscoveredOAuthConfig> {
  const prm = await discoverResourceMetadata(mcpUrl);
  const resource = prm?.resource ?? mcpUrl;
  const issuers = prm?.authorization_servers?.length
    ? prm.authorization_servers
    : [new URL(mcpUrl).origin];

  for (const issuer of issuers) {
    const metadata = await discoverIssuerMetadata(issuer);
    if (!metadata) continue;
    return {
      metadata,
      resource,
      scopesSupported: prm?.scopes_supported ?? metadata.scopes_supported ?? null,
    };
  }

  log.warn('No OAuth metadata published; falling back to origin-root endpoints', { mcpUrl });
  return {
    metadata: originRootMetadata(mcpUrl),
    resource,
    scopesSupported: prm?.scopes_supported ?? null,
  };
}

export interface RegisteredClient {
  clientId: string;
  clientSecret: string | null;
}

/**
 * RFC 7591 dynamic client registration. `token_endpoint_auth_method: "none"` is
 * only requested when the server advertises it — asking for it unprompted is a
 * known way to get `invalid_client_metadata` from servers that only issue
 * confidential clients.
 */
export async function registerOAuthClient(params: {
  metadata: AuthorizationServerMetadata;
  redirectUri: string;
  scope: string | null;
}): Promise<RegisteredClient> {
  const supportsPublicClient =
    params.metadata.token_endpoint_auth_methods_supported?.includes('none') ?? false;
  try {
    const registered = await registerClient(params.metadata.issuer, {
      metadata: params.metadata,
      clientMetadata: {
        client_name: 'Clawed Abode',
        redirect_uris: [params.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...(supportsPublicClient ? { token_endpoint_auth_method: 'none' } : {}),
      },
      scope: params.scope ?? undefined,
      fetchFn: fetchWithTimeout,
    });
    return { clientId: registered.client_id, clientSecret: registered.client_secret ?? null };
  } catch (error) {
    throw new Error(
      `Dynamic client registration failed: ${toError(error).message.slice(0, 300)}. ` +
        'Register a client with this server by hand and enter its client ID.'
    );
  }
}
