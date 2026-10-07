import { randomBytes } from 'crypto';
import { processSingleton } from '@/lib/process-singleton';

// Long enough to survive a slow link open, short enough that a code left in
// browser history is dead by the time anyone could read it.
export const PUBLIC_LOGIN_CODE_TTL_MS = 60 * 1000;

/**
 * Code → expiry. In memory: the public files server runs in this process, and a
 * restart only costs a re-tap.
 */
const codes = processSingleton('public-login-codes', () => new Map<string, number>());

export function mintPublicLoginCode(): string {
  const now = Date.now();
  for (const [code, expiresAt] of codes) {
    if (expiresAt <= now) codes.delete(code);
  }
  const code = randomBytes(32).toString('base64url');
  codes.set(code, now + PUBLIC_LOGIN_CODE_TTL_MS);
  return code;
}

/** True at most once per code, and only before it expires. */
export function consumePublicLoginCode(code: string): boolean {
  const expiresAt = codes.get(code);
  if (expiresAt === undefined) return false;
  codes.delete(code);
  return expiresAt > Date.now();
}
