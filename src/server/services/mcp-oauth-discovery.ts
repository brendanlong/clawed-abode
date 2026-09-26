import { z } from 'zod';
import {
  buildDiscoveryUrls,
  extractWWWAuthenticateParams,
  registerClient,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createLogger, toError } from '@/lib/logger';
import { isHttpUrl, protectedResourceMetadataUrls } from '@/lib/mcp-oauth-urls';

const log = createLogger('mcp-oauth-discovery');

export function fetchWithTimeout(ms: number): FetchLike {
  return (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

const discoveryFetch = fetchWithTimeout(10_000);

/**
 * RFC 9728 protected-resource metadata. Deliberately laxer than the SDK's schema,
 * which drops the whole document (and with it `authorization_servers`) when
 * `resource` is missing.
 */
const protectedResourceMetadataSchema = z.object({
  resource: z.string().optional(),
  authorization_servers: z.array(z.string()).optional(),
  scopes_supported: z.array(z.string()).optional(),
});

/**
 * The SDK rejects only `javascript:`/`data:`/`vbscript:`; the authorization
 * endpoint ends up in `window.location.assign`, so allow http(s) and nothing else.
 */
const httpUrlSchema = z.string().refine(isHttpUrl, { message: 'must be an http(s) URL' });

/**
 * RFC 8414 / OIDC authorization-server metadata, requiring only what the flow
 * uses — the SDK's OIDC schema also demands `jwks_uri` and friends.
 */
const authorizationServerMetadataSchema = z.looseObject({
  issuer: z.string().optional(),
  authorization_endpoint: httpUrlSchema,
  token_endpoint: httpUrlSchema,
  registration_endpoint: httpUrlSchema.optional(),
  response_types_supported: z.array(z.string()).optional(),
  scopes_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});

export interface DiscoveredOAuthConfig {
  /** Real metadata, or origin-root endpoints synthesized when the server publishes none. */
  metadata: AuthorizationServerMetadata;
  /** RFC 8707 resource indicator to request tokens for. */
  resource: string;
  /** Scopes the resource accepts — the PRM's list, not the AS's broader one. */
  scopesSupported: string[] | null;
}

/** Try each URL in turn, skipping any that fails for any reason (unlike the SDK, which stops on a 5xx or malformed document). */
async function fetchFirstMatching<T>(urls: string[], schema: z.ZodType<T>): Promise<T | null> {
  for (const url of urls) {
    try {
      const response = await discoveryFetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        await response.body?.cancel();
        continue;
      }
      const parsed = schema.safeParse(await response.json());
      if (parsed.success) return parsed.data;
      log.info('Ignoring malformed metadata document', { url });
    } catch (error) {
      log.debug('Metadata fetch failed', { url, error: toError(error).message });
    }
  }
  return null;
}

/**
 * Ask the MCP endpoint who guards it. A spec-compliant server answers an
 * unauthenticated request with 401 + `WWW-Authenticate: Bearer
 * resource_metadata="..."`; that pointer is authoritative.
 */
async function probeResourceMetadataUrl(mcpUrl: string): Promise<string | null> {
  try {
    const response = await discoveryFetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    await response.body?.cancel();
    if (response.status !== 401) return null;
    return extractWWWAuthenticateParams(response).resourceMetadataUrl?.href ?? null;
  } catch (error) {
    log.info('Unauthenticated probe of MCP endpoint failed', {
      mcpUrl,
      error: toError(error).message,
    });
    return null;
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
  const advertised = await probeResourceMetadataUrl(mcpUrl);
  const prm = await fetchFirstMatching(
    [...(advertised ? [advertised] : []), ...protectedResourceMetadataUrls(mcpUrl)],
    protectedResourceMetadataSchema
  );

  const resource = prm?.resource ?? mcpUrl;
  const issuers = prm?.authorization_servers?.length
    ? prm.authorization_servers
    : [new URL(mcpUrl).origin];

  for (const issuer of issuers) {
    const metadata = await fetchFirstMatching(
      buildDiscoveryUrls(issuer).map(({ url }) => url.href),
      authorizationServerMetadataSchema
    );
    if (!metadata) continue;
    return {
      metadata: {
        ...metadata,
        issuer: metadata.issuer ?? issuer,
        response_types_supported: metadata.response_types_supported ?? ['code'],
      },
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
      fetchFn: discoveryFetch,
    });
    return { clientId: registered.client_id, clientSecret: registered.client_secret ?? null };
  } catch (error) {
    throw new Error(
      `Dynamic client registration failed: ${toError(error).message.slice(0, 300)}. ` +
        'Register a client with this server by hand and enter its client ID.'
    );
  }
}
