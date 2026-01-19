import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import { z } from 'zod';

const SALT_ROUNDS = 12;
const TOKEN_LENGTH = 32; // 256 bits of entropy
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export type LoginInput = z.infer<typeof loginSchema>;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateSessionToken(): string {
  return randomBytes(TOKEN_LENGTH).toString('hex');
}

export function parseAuthHeader(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1];
}
