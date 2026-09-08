import { NextResponse, type NextRequest } from 'next/server';
import { createLogger, toError } from '@/lib/logger';
import { completeMcpOAuthFlow } from '@/server/services/mcp-oauth';

const log = createLogger('mcp-oauth-callback');

/**
 * Where an authorization server sends the user's browser after they approve (or
 * decline) an MCP server's OAuth request.
 *
 * This runs unauthenticated: the app authenticates with a bearer token the
 * browser only attaches to its own tRPC calls, and a cross-site redirect carries
 * no such header. The request's credential is the `state` parameter — 256 bits
 * of randomness bound to one pending flow and consumed on use — which is exactly
 * the protection OAuth's CSRF design asks of a client. Nothing here reads or
 * trusts anything else from the query string.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get('state');
  const code = params.get('code');
  const error = params.get('error');

  if (error) {
    const description = params.get('error_description');
    return settingsRedirect(request, {
      error: description ? `${error}: ${description}` : error,
    });
  }
  if (!state || !code) {
    return settingsRedirect(request, { error: 'Authorization response was missing code or state' });
  }

  try {
    const { serverName } = await completeMcpOAuthFlow({ state, code });
    return settingsRedirect(request, { connected: serverName });
  } catch (err) {
    log.error('MCP OAuth callback failed', toError(err));
    return settingsRedirect(request, {
      error: err instanceof Error ? err.message : 'Authorization failed',
    });
  }
}

function settingsRedirect(
  request: NextRequest,
  result: { connected: string } | { error: string }
): NextResponse {
  const url = new URL('/settings', request.nextUrl.origin);
  if ('connected' in result) {
    url.searchParams.set('mcpConnected', result.connected);
  } else {
    url.searchParams.set('mcpAuthError', result.error);
  }
  return NextResponse.redirect(url);
}
