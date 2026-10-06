import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { z } from 'zod';

const TOKEN_LENGTH = 32; // 256 bits of entropy
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
export const ACTIVITY_UPDATE_THROTTLE_MS = 60 * 1000; // 1 minute - minimum time between activity updates
// How long expired/revoked auth sessions stay listed for audit before being deleted
export const AUTH_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * When an auth session stops being accepted: its absolute `expiresAt`, or
 * IDLE_TIMEOUT_MS after its last activity, whichever comes first.
 */
export function effectiveExpiry(session: { lastActivityAt: Date; expiresAt: Date }): Date {
  const idleExpiresAt = new Date(session.lastActivityAt.getTime() + IDLE_TIMEOUT_MS);
  return idleExpiresAt < session.expiresAt ? idleExpiresAt : session.expiresAt;
}

/**
 * `effectiveExpiry` as a query filter: sessions that are neither revoked nor past
 * it at `now`. For conditional writes that must check liveness in the same statement.
 */
export function liveSessionWhere(now: Date) {
  return {
    revokedAt: null,
    expiresAt: { gt: now },
    lastActivityAt: { gt: new Date(now.getTime() - IDLE_TIMEOUT_MS) },
  };
}

/**
 * What an auth session may reach. `public_files` sessions come from the public
 * files server's one-time-code login and are accepted only there; signing in
 * with the password from the same browser upgrades one to `full`.
 */
export const authScopeSchema = z.enum(['full', 'public_files']);
export type AuthScope = z.infer<typeof authScopeSchema>;

export const loginSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

export function generateSessionToken(): string {
  return randomBytes(TOKEN_LENGTH).toString('hex');
}

export function parseAuthHeader(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) return null;
  return parts[1];
}
