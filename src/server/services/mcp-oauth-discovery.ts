import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import {
  authorizationServerMetadataUrls,
  fallbackAuthorizationServerEndpoints,
  originOf,
  parseWwwAuthenticate,
  protectedResourceMetadataUrls,
} from '@/lib/mcp-oauth-urls';

const log = createLogger('mcp-oauth-discovery');

const DISCOVERY_TIMEOUT_MS = 10_000;

/** RFC 9728 protected-resource metadata. */
const protectedResourceMetadataSchema = z.object({
  resource: z.string().optional(),
  authorization_servers: z.array(z.string()).optional(),
  scopes_supported: z.array(z.string()).optional(),
});

/** RFC 8414 / OIDC authorization-server metadata. */
const authorizationServerMetadataSchema = z.object({
  issuer: z.string().optional(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  scopes_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});

export type AuthorizationServerMetadata = z.infer<typeof authorizationServerMetadataSchema>;

export interface DiscoveredOAuthConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  /** RFC 8707 resource indicator to request tokens for. */
  resource: string;
  /** Scopes the resource accepts — the PRM's list, not the AS's broader one. */
  scopesSupported: string[] | null;
  /** Whether the AS accepts public (PKCE-only) clients at the token endpoint. */
  supportsPublicClient: boolean;
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    log.debug('Metadata fetch failed', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function fetchFirstMatching<T>(urls: string[], schema: z.ZodType<T>): Promise<T | null> {
  for (const url of urls) {
    const body = await fetchJson(url);
    if (body === null) continue;
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    log.info('Ignoring malformed metadata document', { url });
  }
  return null;
}

/**
 * Ask the MCP endpoint who guards it. A spec-compliant server answers an
 * unauthenticated request with 401 + `WWW-Authenticate: Bearer
 * resource_metadata="..."`; that pointer is authoritative, because a server
 * whose resource has a path publishes its metadata at the path-inserted
 * location, which we would otherwise only find on the second try.
 */
async function probeResourceMetadataUrl(mcpUrl: string): Promise<string | null> {
  try {
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (response.status !== 401) return null;
    return parseWwwAuthenticate(response.headers.get('www-authenticate')).resource_metadata ?? null;
  } catch (error) {
    log.info('Unauthenticated probe of MCP endpoint failed', {
      mcpUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Resolve everything needed to run an authorization-code flow against a remote
 * MCP server, degrading one step at a time: the advertised metadata pointer,
 * then the well-known locations, then the origin-root endpoints other MCP
 * clients synthesize. Only a server that publishes nothing anywhere fails.
 */
export async function discoverMcpOAuth(mcpUrl: string): Promise<DiscoveredOAuthConfig> {
  const advertised = await probeResourceMetadataUrl(mcpUrl);
  const prmUrls = advertised
    ? [advertised, ...protectedResourceMetadataUrls(mcpUrl)]
    : protectedResourceMetadataUrls(mcpUrl);
  const prm = await fetchFirstMatching(prmUrls, protectedResourceMetadataSchema);

  const resource = prm?.resource ?? mcpUrl;
  const issuerCandidates = prm?.authorization_servers?.length
    ? prm.authorization_servers
    : [originOf(mcpUrl)];

  for (const issuer of issuerCandidates) {
    const metadata = await fetchFirstMatching(
      authorizationServerMetadataUrls(issuer),
      authorizationServerMetadataSchema
    );
    if (!metadata) continue;
    return {
      issuer: metadata.issuer ?? issuer,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      registrationEndpoint: metadata.registration_endpoint ?? null,
      resource,
      scopesSupported: prm?.scopes_supported ?? metadata.scopes_supported ?? null,
      supportsPublicClient:
        metadata.token_endpoint_auth_methods_supported?.includes('none') ?? false,
    };
  }

  log.warn('No OAuth metadata published; falling back to origin-root endpoints', { mcpUrl });
  return {
    ...fallbackAuthorizationServerEndpoints(mcpUrl),
    resource,
    scopesSupported: prm?.scopes_supported ?? null,
    supportsPublicClient: false,
  };
}

const registrationResponseSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
});

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
  registrationEndpoint: string;
  redirectUri: string;
  scope: string | null;
  supportsPublicClient: boolean;
}): Promise<RegisteredClient> {
  const body: Record<string, unknown> = {
    client_name: 'Clawed Abode',
    redirect_uris: [params.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
  if (params.supportsPublicClient) body.token_endpoint_auth_method = 'none';
  if (params.scope) body.scope = params.scope;

  const response = await fetch(params.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Dynamic client registration failed (${response.status}): ${text.slice(0, 300)}. ` +
        'Register a client with this server by hand and enter its client ID.'
    );
  }

  const parsed = registrationResponseSchema.safeParse(safeJsonParse(text));
  if (!parsed.success) {
    throw new Error(
      'Dynamic client registration returned no client_id. ' +
        'Register a client with this server by hand and enter its client ID.'
    );
  }
  return { clientId: parsed.data.client_id, clientSecret: parsed.data.client_secret ?? null };
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
