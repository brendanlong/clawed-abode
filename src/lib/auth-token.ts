/**
 * Client-side auth token storage. Centralized so the tRPC client, auth context,
 * and plain `fetch` callers (e.g. the file-upload route) share one key.
 */
const AUTH_TOKEN_KEY = 'auth_token';

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

/** The bearer `authorization` header for `token` (the stored one by default), or none. */
export function authHeaders(token = getAuthToken()): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function clearAuthToken(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(AUTH_TOKEN_KEY);
}
