import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  parseAuthHeader,
  loginSchema,
  SESSION_DURATION_MS,
} from './auth';

describe('auth', () => {
  describe('hashPassword and verifyPassword', () => {
    it('should hash a password and verify it correctly', async () => {
      const password = 'test-password-123';
      const hash = await hashPassword(password);

      expect(hash).not.toBe(password);
      expect(hash).toMatch(/^\$argon2/); // Argon2 hash format

      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('should reject incorrect passwords', async () => {
      const password = 'correct-password';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword('wrong-password', hash);
      expect(isValid).toBe(false);
    });

    // PASSWORD_HASH is minted once by scripts/hash-password.ts and then lives in
    // the user's env forever, so an argon2 upgrade that stopped verifying older
    // encoded hashes would lock them out of their own server. This hash was
    // produced by argon2 0.43.1.
    it('verifies a hash minted by an older argon2 release', async () => {
      const legacyHash =
        '$argon2id$v=19$m=65536,t=3,p=4$JNHWoSjmKZtR7C+yCYIPDw$McGhI2hfQf3tps3ZVhVaml4Z4CqsiaweANDyUUJl7oo';

      expect(await verifyPassword('correct horse battery staple', legacyHash)).toBe(true);
      expect(await verifyPassword('wrong password', legacyHash)).toBe(false);
    });

    it('should generate different hashes for the same password', async () => {
      const password = 'same-password';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);

      expect(hash1).not.toBe(hash2); // Salt should be different
    });
  });

  describe('generateSessionToken', () => {
    it('should generate a 64-character hex token (256 bits)', () => {
      const token = generateSessionToken();

      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]+$/);
    });

    it('should generate unique tokens', () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 100; i++) {
        tokens.add(generateSessionToken());
      }
      expect(tokens.size).toBe(100);
    });
  });

  describe('parseAuthHeader', () => {
    it('should parse a valid Bearer token', () => {
      const token = parseAuthHeader('Bearer abc123token');
      expect(token).toBe('abc123token');
    });

    it('should return null for null header', () => {
      const token = parseAuthHeader(null);
      expect(token).toBeNull();
    });

    it('should return null for empty header', () => {
      const token = parseAuthHeader('');
      expect(token).toBeNull();
    });

    it('should return null for non-Bearer auth', () => {
      const token = parseAuthHeader('Basic dXNlcjpwYXNz');
      expect(token).toBeNull();
    });

    it('should return null for malformed Bearer token', () => {
      expect(parseAuthHeader('Bearer')).toBeNull();
      expect(parseAuthHeader('Bearer token extra')).toBeNull();
    });

    it('should return null for Bearer with empty token', () => {
      expect(parseAuthHeader('Bearer ')).toBeNull();
    });

    it('should handle bearer with different casing (case-sensitive)', () => {
      // Bearer is case-sensitive per RFC 6750
      expect(parseAuthHeader('bearer abc123')).toBeNull();
      expect(parseAuthHeader('BEARER abc123')).toBeNull();
    });
  });

  describe('loginSchema', () => {
    it('should accept valid password', () => {
      const result = loginSchema.safeParse({ password: 'my-password' });
      expect(result.success).toBe(true);
    });

    it('should reject empty password', () => {
      const result = loginSchema.safeParse({ password: '' });
      expect(result.success).toBe(false);
    });

    it('should reject missing password', () => {
      const result = loginSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe('SESSION_DURATION_MS', () => {
    it('should be 7 days in milliseconds', () => {
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(SESSION_DURATION_MS).toBe(sevenDaysMs);
    });
  });
});
