/**
 * Simple in-memory rate limiter for login attempts.
 * Uses IP-based tracking with exponential backoff after failed attempts.
 */

export interface RateLimitConfig {
  maxAttempts: number; // Max attempts before lockout
  lockoutDurationMs: number; // Base lockout duration in ms
  windowMs: number; // Time window for tracking attempts
}

export interface RateLimitEntry {
  attempts: number;
  firstAttemptAt: number;
  lockedUntil: number | null;
  lockoutCount: number; // Number of times locked out (for exponential backoff)
}

export interface RateLimitResult {
  allowed: boolean;
  remainingAttempts: number;
  retryAfterMs: number | null;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxAttempts: 5,
  lockoutDurationMs: 15 * 60 * 1000, // 15 minutes
  windowMs: 15 * 60 * 1000, // 15 minute window
};

export class RateLimiter {
  private entries: Map<string, RateLimitEntry> = new Map();
  private config: RateLimitConfig;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };
  }

  /**
   * Check if a request is allowed for the given key (typically IP address).
   * Call this BEFORE attempting authentication.
   */
  check(key: string): RateLimitResult {
    const now = Date.now();
    const entry = this.entries.get(key);

    // No previous attempts - allow
    if (!entry) {
      return {
        allowed: true,
        remainingAttempts: this.config.maxAttempts,
        retryAfterMs: null,
      };
    }

    // Check if currently locked out
    if (entry.lockedUntil !== null && now < entry.lockedUntil) {
      return {
        allowed: false,
        remainingAttempts: 0,
        retryAfterMs: entry.lockedUntil - now,
      };
    }

    // Check if lockout has expired - reset lockout but keep lockout count for exponential backoff
    if (entry.lockedUntil !== null && now >= entry.lockedUntil) {
      entry.lockedUntil = null;
      entry.attempts = 0;
      entry.firstAttemptAt = now;
      // Keep lockoutCount for exponential backoff - don't reset it here
    }

    // Check if window has expired AND we're not in an active lockout sequence
    // Only reset lockoutCount if enough time has passed since the last lockout ended
    if (now - entry.firstAttemptAt > this.config.windowMs && entry.lockedUntil === null) {
      entry.attempts = 0;
      entry.firstAttemptAt = now;
      entry.lockoutCount = 0; // Reset exponential backoff after clean window
    }

    const remainingAttempts = Math.max(0, this.config.maxAttempts - entry.attempts);

    return {
      allowed: remainingAttempts > 0,
      remainingAttempts,
      retryAfterMs: null,
    };
  }

  /**
   * Record a failed authentication attempt for the given key.
   * Call this AFTER a failed authentication.
   */
  recordFailure(key: string): RateLimitResult {
    const now = Date.now();
    let entry = this.entries.get(key);

    if (!entry) {
      entry = {
        attempts: 0,
        firstAttemptAt: now,
        lockedUntil: null,
        lockoutCount: 0,
      };
      this.entries.set(key, entry);
    }

    // Check if lockout has expired - reset attempts but keep lockout count
    if (entry.lockedUntil !== null && now >= entry.lockedUntil) {
      entry.lockedUntil = null;
      entry.attempts = 0;
      entry.firstAttemptAt = now;
      // Keep lockoutCount for exponential backoff - don't reset it here
    }

    // Check if window has expired AND we're not in an active lockout sequence
    // Only reset lockoutCount if enough time has passed since the last lockout ended
    if (now - entry.firstAttemptAt > this.config.windowMs && entry.lockedUntil === null) {
      entry.attempts = 0;
      entry.firstAttemptAt = now;
      entry.lockoutCount = 0;
    }

    entry.attempts++;

    // Check if we've hit the limit
    if (entry.attempts >= this.config.maxAttempts) {
      // Calculate lockout duration with exponential backoff
      // 15 min -> 30 min -> 60 min -> 120 min, capped at 2 hours
      const backoffMultiplier = Math.pow(2, entry.lockoutCount);
      const lockoutDuration = Math.min(
        this.config.lockoutDurationMs * backoffMultiplier,
        2 * 60 * 60 * 1000 // Max 2 hours
      );
      entry.lockedUntil = now + lockoutDuration;
      entry.lockoutCount++;

      return {
        allowed: false,
        remainingAttempts: 0,
        retryAfterMs: lockoutDuration,
      };
    }

    return {
      allowed: true,
      remainingAttempts: this.config.maxAttempts - entry.attempts,
      retryAfterMs: null,
    };
  }

  /**
   * Record a successful authentication for the given key.
   * Resets the attempt counter but keeps lockout history for a grace period.
   */
  recordSuccess(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.attempts = 0;
      entry.lockedUntil = null;
      // Reset firstAttemptAt to start a fresh window, but keep lockoutCount
      // This prevents attackers from resetting backoff by getting one success
      entry.firstAttemptAt = Date.now();
    }
  }

  /**
   * Clear rate limit data for a specific key (useful for testing or admin reset).
   */
  reset(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Clear all rate limit data (useful for testing or server restart).
   */
  resetAll(): void {
    this.entries.clear();
  }

  /**
   * Clean up expired entries to prevent memory leaks.
   * Call this periodically (e.g., every hour).
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.entries) {
      // Remove entries that are unlocked and whose window has expired
      const windowExpired = now - entry.firstAttemptAt > this.config.windowMs;
      const notLockedOut = entry.lockedUntil === null || now >= entry.lockedUntil;

      if (windowExpired && notLockedOut) {
        this.entries.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Get the current number of tracked entries (useful for monitoring).
   */
  get size(): number {
    return this.entries.size;
  }
}

// Singleton instance for the login rate limiter
export const loginRateLimiter = new RateLimiter();

// Start cleanup interval (every hour)
if (typeof setInterval !== 'undefined') {
  setInterval(
    () => {
      loginRateLimiter.cleanup();
    },
    60 * 60 * 1000
  );
}
