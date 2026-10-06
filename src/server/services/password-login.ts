import { verifyPassword } from '@/lib/auth';
import { loginRateLimiter } from '@/lib/rate-limiter';
import { env } from '@/lib/env';
import { createLogger, toError } from '@/lib/logger';
import { createAuthSession, purgeInactiveAuthSessions } from './auth-sessions';

const log = createLogger('password-login');

export interface ClientInfo {
  /** From request headers, never client input, which an attacker could vary to dodge the rate limiter. */
  ipAddress?: string;
  userAgent?: string;
}

export type PasswordLoginResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'rate_limited'; retryAfterMs: number }
  | { ok: false; reason: 'invalid_password' }
  | { ok: false; reason: 'not_configured' | 'bad_hash' };

/**
 * Check the password against PASSWORD_HASH under the shared login rate limiter
 * and open an auth session on success. Shared by the app's login and the public
 * files server's login page, so neither can be used to dodge the other's limit.
 */
export async function loginWithPassword(
  password: string,
  client: ClientInfo
): Promise<PasswordLoginResult> {
  const rateLimitKey = client.ipAddress ?? 'unknown';
  const rateLimitCheck = loginRateLimiter.check(rateLimitKey);
  if (!rateLimitCheck.allowed) {
    log.warn('Login rate limited', { ip: client.ipAddress });
    return { ok: false, reason: 'rate_limited', retryAfterMs: rateLimitCheck.retryAfterMs ?? 0 };
  }

  if (!env.PASSWORD_HASH) return { ok: false, reason: 'not_configured' };

  let valid: boolean;
  try {
    valid = await verifyPassword(password, env.PASSWORD_HASH);
  } catch (error) {
    log.error('Password verification error', toError(error));
    return { ok: false, reason: 'bad_hash' };
  }

  if (!valid) {
    const failureResult = loginRateLimiter.recordFailure(rateLimitKey);
    log.warn('Failed login attempt', {
      ip: client.ipAddress,
      remainingAttempts: failureResult.remainingAttempts,
    });
    return { ok: false, reason: 'invalid_password' };
  }

  loginRateLimiter.recordSuccess(rateLimitKey);

  try {
    await purgeInactiveAuthSessions();
  } catch (error) {
    log.error('Failed to purge inactive auth sessions', toError(error));
  }

  return { ok: true, token: await createAuthSession(client.ipAddress, client.userAgent) };
}

export function retryAfterMessage(retryAfterMs: number): string {
  const minutes = Math.ceil(retryAfterMs / 60000);
  return `Too many login attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}
