/**
 * An endpoint we will either navigate the browser to or post credentials to.
 * `new URL()` happily parses `javascript:`, and the authorization endpoint ends
 * up in `window.location.assign`.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
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
