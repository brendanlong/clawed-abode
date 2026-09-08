/**
 * Pure URL/header construction for the MCP OAuth client. Everything here is
 * spec plumbing (RFC 9728 / 8414 / 7636 / 8707) with no I/O, so the rules that
 * remote servers most often get wrong are unit-testable on their own.
 */

/** Parsed `WWW-Authenticate` challenge parameters (`resource_metadata`, `scope`, ...). */
export function parseWwwAuthenticate(header: string | null | undefined): Record<string, string> {
  if (!header) return {};
  // Drop the auth-scheme token ("Bearer"); everything after it is `key=value` pairs.
  const params = header.replace(/^\s*[A-Za-z][A-Za-z0-9-]*\s+/, '');
  const result: Record<string, string> = {};
  for (const match of params.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)) {
    result[match[1].toLowerCase()] = match[2] ?? match[3];
  }
  return result;
}

/** Strip a URL down to `scheme://host[:port]`. */
export function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * Where to look for a resource's RFC 9728 metadata, most authoritative first.
 *
 * §3.1 inserts `/.well-known/oauth-protected-resource` **before** the resource's
 * path, so `https://host/api/mcp` publishes at
 * `https://host/.well-known/oauth-protected-resource/api/mcp`. The root location
 * is only authoritative for a bare-origin resource, but plenty of servers serve
 * it there anyway, so it stays as a fallback.
 */
export function protectedResourceMetadataUrls(resourceUrl: string): string[] {
  const url = new URL(resourceUrl);
  const path = url.pathname.replace(/\/+$/, '');
  const root = `${url.origin}/.well-known/oauth-protected-resource`;
  return path && path !== '/' ? [`${root}${path}`, root] : [root];
}

/**
 * Where to look for an authorization server's metadata, most standard first:
 * RFC 8414 path-insertion, then the OIDC variants (an issuer with a path is
 * exactly where clients most often derive the wrong URL and give up).
 */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  if (!path || path === '/') {
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

/**
 * Endpoints to assume when a server publishes no metadata at all. Mirrors what
 * other MCP clients synthesize: the origin root, never the resource's path.
 */
export function fallbackAuthorizationServerEndpoints(resourceUrl: string) {
  const origin = originOf(resourceUrl);
  return {
    issuer: origin,
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    registrationEndpoint: `${origin}/register`,
  };
}

export interface AuthorizeUrlParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope?: string | null;
  /** RFC 8707 resource indicator — the canonical MCP URL the token is minted for. */
  resource?: string | null;
}

export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const url = new URL(params.authorizationEndpoint);
  const query = url.searchParams;
  query.set('response_type', 'code');
  query.set('client_id', params.clientId);
  query.set('redirect_uri', params.redirectUri);
  query.set('state', params.state);
  query.set('code_challenge', params.codeChallenge);
  query.set('code_challenge_method', 'S256');
  if (params.scope) query.set('scope', params.scope);
  if (params.resource) query.set('resource', params.resource);
  return url.toString();
}

/** The app's own OAuth callback, which must be reachable from the user's browser. */
export const MCP_OAUTH_CALLBACK_PATH = '/api/mcp/oauth/callback';

export function mcpOAuthRedirectUri(appOrigin: string): string {
  return `${appOrigin.replace(/\/+$/, '')}${MCP_OAUTH_CALLBACK_PATH}`;
}

/** Refresh this far before actual expiry so a token can't die mid-turn. */
export const TOKEN_EXPIRY_SKEW_MS = 60_000;

export function isAccessTokenFresh(expiresAt: Date | null | undefined, now: Date): boolean {
  // No expiry means the server issued a non-expiring token; treat it as fresh.
  if (!expiresAt) return true;
  return expiresAt.getTime() - now.getTime() > TOKEN_EXPIRY_SKEW_MS;
}

/** An authorization that was started and never came back is abandoned, not pending. */
export const OAUTH_FLOW_TTL_MS = 15 * 60 * 1000;

export function isFlowExpired(startedAt: Date | null | undefined, now: Date): boolean {
  if (!startedAt) return true;
  return now.getTime() - startedAt.getTime() > OAUTH_FLOW_TTL_MS;
}
