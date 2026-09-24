import { NextResponse } from 'next/server';
import { parseAuthHeader, SESSION_DURATION_MS } from '@/lib/auth';
import { resolveAuthSessionId } from '@/server/services/auth-sessions';
import { PUBLIC_AUTH_COOKIE } from '@/lib/public-files';
import { env } from '@/lib/env';

const COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
} as const;

/**
 * Mirrors the caller's bearer token into the cookie the public files server
 * (src/server/services/public-files-server.ts) authenticates with. Cookies ignore
 * ports, so one set here reaches that server as long as it shares the app's
 * hostname. The client calls this whenever it holds a token, so logins from
 * before the cookie existed pick it up. The app's own routes ignore the cookie.
 * Cookies reach every port on the hostname, so it is only set when the feature is on.
 */
export async function POST(request: Request): Promise<Response> {
  if (!env.PUBLIC_FILES_URL) {
    return Response.json({ error: 'Public files are not configured' }, { status: 404 });
  }
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
