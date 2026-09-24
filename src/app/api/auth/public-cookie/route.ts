import { NextResponse } from 'next/server';
import { parseAuthHeader, SESSION_DURATION_MS } from '@/lib/auth';
import { resolveAuthSessionId } from '@/server/trpc';
import { PUBLIC_AUTH_COOKIE, PUBLIC_URL_PREFIX } from '@/lib/public-files';

const COOKIE_OPTIONS = {
  path: PUBLIC_URL_PREFIX,
  httpOnly: true,
  secure: true,
  sameSite: 'none',
} as const;

/**
 * Mirrors the caller's bearer token into the cookie that authenticates plain
 * browser requests to `/public/…` (see src/app/public/). The client calls this
 * whenever it holds a token, so logins from before the cookie existed pick it up.
 *
 * SameSite=None because public pages are served with a CSP sandbox, which gives
 * them an opaque origin: their own subresource requests (images, scripts) count
 * as cross-site and a Lax cookie would be withheld. The cookie is path-scoped and
 * only authorizes reads of public files, so cross-site sending grants nothing new
 * beyond what the session UUID in the URL already gates.
 */
export async function POST(request: Request): Promise<Response> {
  const token = parseAuthHeader(request.headers.get('authorization'));
  if (!token || !(await resolveAuthSessionId(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(PUBLIC_AUTH_COOKIE, token, {
    ...COOKIE_OPTIONS,
    maxAge: SESSION_DURATION_MS / 1000,
  });
  return response;
}

export async function DELETE(): Promise<Response> {
  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(PUBLIC_AUTH_COOKIE, '', { ...COOKIE_OPTIONS, maxAge: 0 });
  return response;
}
