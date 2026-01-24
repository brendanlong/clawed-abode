import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimiter, DEFAULT_RATE_LIMIT_CONFIG } from './rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('check', () => {
    it('should allow first request from unknown IP', () => {
      const result = limiter.check('192.168.1.1');
      expect(result.allowed).toBe(true);
      expect(result.remainingAttempts).toBe(DEFAULT_RATE_LIMIT_CONFIG.maxAttempts);
      expect(result.retryAfterMs).toBeNull();
    });

    it('should allow requests when under the limit', () => {
      // Record a few failures
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      const result = limiter.check('192.168.1.1');
      expect(result.allowed).toBe(true);
      expect(result.remainingAttempts).toBe(DEFAULT_RATE_LIMIT_CONFIG.maxAttempts - 2);
    });

    it('should block requests during lockout', () => {
      // Exhaust all attempts
      for (let i = 0; i < DEFAULT_RATE_LIMIT_CONFIG.maxAttempts; i++) {
        limiter.recordFailure('192.168.1.1');
      }

      const result = limiter.check('192.168.1.1');
      expect(result.allowed).toBe(false);
      expect(result.remainingAttempts).toBe(0);
      expect(result.retryAfterMs).toBe(DEFAULT_RATE_LIMIT_CONFIG.lockoutDurationMs);
    });

    it('should allow requests after lockout expires', () => {
      // Exhaust all attempts
      for (let i = 0; i < DEFAULT_RATE_LIMIT_CONFIG.maxAttempts; i++) {
        limiter.recordFailure('192.168.1.1');
      }

      // Fast forward past lockout
      vi.advanceTimersByTime(DEFAULT_RATE_LIMIT_CONFIG.lockoutDurationMs + 1);

      const result = limiter.check('192.168.1.1');
      expect(result.allowed).toBe(true);
      expect(result.remainingAttempts).toBe(DEFAULT_RATE_LIMIT_CONFIG.maxAttempts);
    });

    it('should track different IPs independently', () => {
      // Lock out IP1
      for (let i = 0; i < DEFAULT_RATE_LIMIT_CONFIG.maxAttempts; i++) {
        limiter.recordFailure('192.168.1.1');
      }

      // IP2 should still be allowed
      const result = limiter.check('192.168.1.2');
      expect(result.allowed).toBe(true);
      expect(result.remainingAttempts).toBe(DEFAULT_RATE_LIMIT_CONFIG.maxAttempts);
    });
  });

  describe('recordFailure', () => {
    it('should increment attempt count', () => {
      let result = limiter.recordFailure('192.168.1.1');
      expect(result.remainingAttempts).toBe(DEFAULT_RATE_LIMIT_CONFIG.maxAttempts - 1);

      result = limiter.recordFailure('192.168.1.1');
      expect(result.remainingAttempts).toBe(DEFAULT_RATE_LIMIT_CONFIG.maxAttempts - 2);
    });

    it('should trigger lockout at max attempts', () => {
      let result;
      for (let i = 0; i < DEFAULT_RATE_LIMIT_CONFIG.maxAttempts - 1; i++) {
        result = limiter.recordFailure('192.168.1.1');
        expect(result.allowed).toBe(true);
      }

      result = limiter.recordFailure('192.168.1.1');
      expect(result.allowed).toBe(false);
      expect(result.remainingAttempts).toBe(0);
      expect(result.retryAfterMs).toBe(DEFAULT_RATE_LIMIT_CONFIG.lockoutDurationMs);
    });

    it('should reset attempts when window expires', () => {
      // Record some failures
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      // Fast forward past window
      vi.advanceTimersByTime(DEFAULT_RATE_LIMIT_CONFIG.windowMs + 1);

      // Should have full attempts again
      const result = limiter.recordFailure('192.168.1.1');
      expect(result.remainingAttempts).toBe(DEFAULT_RATE_LIMIT_CONFIG.maxAttempts - 1);
    });
  });

  describe('exponential backoff', () => {
    it('should double lockout duration after each lockout', () => {
      // First lockout - 15 minutes
      for (let i = 0; i < DEFAULT_RATE_LIMIT_CONFIG.maxAttempts; i++) {
        limiter.recordFailure('192.168.1.1');
      }
      let result = limiter.check('192.168.1.1');
      expect(result.retryAfterMs).toBe(DEFAULT_RATE_LIMIT_CONFIG.lockoutDurationMs);

      // Wait for lockout to expire
      vi.advanceTimersByTime(DEFAULT_RATE_LIMIT_CONFIG.lockoutDurationMs + 1);

      // Second lockout - 30 minutes
      for (let i = 0; i < DEFAULT_RATE_LIMIT_CONFIG.maxAttempts; i++) {
        limiter.recordFailure('192.168.1.1');
      }
      result = limiter.check('192.168.1.1');
      expect(result.retryAfterMs).toBe(DEFAULT_RATE_LIMIT_CONFIG.lockoutDurationMs * 2);

      // Wait for lockout to expire
      vi.advanceTimersByTime(DEFAULT_RATE_LIMIT_CONFIG.lockoutDurationMs * 2 + 1);

      // Third lockout - 60 minutes
      for (let i = 0; i < DEFAULT_RATE_LIMIT_CONFIG.maxAttempts; i++) {
        limiter.recordFailure('192.168.1.1');
      }
      result = limiter.check('192.168.1.1');
      expect(result.retryAfterMs).toBe(DEFAULT_RATE_LIMIT_CONFIG.lockoutDurationMs * 4);
    });

    it('should cap lockout at 2 hours', () => {
      // Trigger many lockouts
      for (let lockout = 0; lockout < 10; lockout++) {
        for (let i = 0; i < DEFAULT_RATE_LIMIT_CONFIG.maxAttempts; i++) {
          limiter.recordFailure('192.168.1.1');
        }

        const result = limiter.check('192.168.1.1');
        expect(result.retryAfterMs).toBeLessThanOrEqual(2 * 60 * 60 * 1000);

        // Wait for lockout to expire
        vi.advanceTimersByTime(result.retryAfterMs! + 1);
      }
    });
  });

  describe('recordSuccess', () => {
    it('should reset attempt count on success', () => {
      // Record some failures
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      // Record success
      limiter.recordSuccess('192.168.1.1');

      // Should have full attempts again
      const result = limiter.check('192.168.1.1');
      expect(result.allowed).toBe(true);
      expect(result.remainingAttempts).toBe(DEFAULT_RATE_LIMIT_CONFIG.maxAttempts);
    });

    it('should keep lockout count for exponential backoff', () => {
      // First lockout
      for (let i = 0; i < DEFAULT_RATE_LIMIT_CONFIG.maxAttempts; i++) {
        limiter.recordFailure('192.168.1.1');
      }

      // Wait for lockout to expire
      vi.advanceTimersByTime(DEFAULT_RATE_LIMIT_CONFIG.lockoutDurationMs + 1);

      // Successful login
      limiter.recordSuccess('192.168.1.1');

      // More failures - should still use exponential backoff
      for (let i = 0; i < DEFAULT_RATE_LIMIT_CONFIG.maxAttempts; i++) {
        limiter.recordFailure('192.168.1.1');
      }

      const result = limiter.check('192.168.1.1');
      // Second lockout should be doubled
      expect(result.retryAfterMs).toBe(DEFAULT_RATE_LIMIT_CONFIG.lockoutDurationMs * 2);
    });

    it('should handle success for unknown IP', () => {
      // Should not throw
      limiter.recordSuccess('192.168.1.1');

      const result = limiter.check('192.168.1.1');
      expect(result.allowed).toBe(true);
    });
  });

  describe('reset', () => {
    it('should clear data for specific IP', () => {
      // Record failures for two IPs
      for (let i = 0; i < DEFAULT_RATE_LIMIT_CONFIG.maxAttempts; i++) {
        limiter.recordFailure('192.168.1.1');
        limiter.recordFailure('192.168.1.2');
      }

      // Reset only IP1
      limiter.reset('192.168.1.1');

      // IP1 should be allowed, IP2 still locked
      expect(limiter.check('192.168.1.1').allowed).toBe(true);
      expect(limiter.check('192.168.1.2').allowed).toBe(false);
    });
  });

  describe('resetAll', () => {
    it('should clear all rate limit data', () => {
      // Lock out multiple IPs
      for (let i = 0; i < DEFAULT_RATE_LIMIT_CONFIG.maxAttempts; i++) {
        limiter.recordFailure('192.168.1.1');
        limiter.recordFailure('192.168.1.2');
      }

      limiter.resetAll();

      expect(limiter.check('192.168.1.1').allowed).toBe(true);
      expect(limiter.check('192.168.1.2').allowed).toBe(true);
      expect(limiter.size).toBe(0);
    });
  });

  describe('cleanup', () => {
    it('should remove expired entries', () => {
      // Record some failures
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.2');

      expect(limiter.size).toBe(2);

      // Fast forward past window
      vi.advanceTimersByTime(DEFAULT_RATE_LIMIT_CONFIG.windowMs + 1);

      const cleaned = limiter.cleanup();
      expect(cleaned).toBe(2);
      expect(limiter.size).toBe(0);
    });

    it('should keep locked out entries until lockout expires', () => {
      // Use a custom limiter with lockout longer than window to test this scenario
      const customLimiter = new RateLimiter({
        maxAttempts: 3,
        windowMs: 5000, // 5 seconds
        lockoutDurationMs: 30000, // 30 seconds - longer than window
      });

      // Lock out an IP
      for (let i = 0; i < 3; i++) {
        customLimiter.recordFailure('192.168.1.1');
      }

      // Fast forward past window but not past lockout
      vi.advanceTimersByTime(6000); // 6 seconds - past 5s window but not 30s lockout

      const cleaned = customLimiter.cleanup();
      expect(cleaned).toBe(0);
      expect(customLimiter.size).toBe(1);

      // Fast forward past lockout
      vi.advanceTimersByTime(25000); // Total 31 seconds - past lockout

      const cleanedAfter = customLimiter.cleanup();
      expect(cleanedAfter).toBe(1);
      expect(customLimiter.size).toBe(0);
    });
  });

  describe('custom config', () => {
    it('should allow custom max attempts', () => {
      const customLimiter = new RateLimiter({ maxAttempts: 3 });

      customLimiter.recordFailure('192.168.1.1');
      customLimiter.recordFailure('192.168.1.1');

      expect(customLimiter.check('192.168.1.1').remainingAttempts).toBe(1);

      customLimiter.recordFailure('192.168.1.1');

      expect(customLimiter.check('192.168.1.1').allowed).toBe(false);
    });

    it('should allow custom lockout duration', () => {
      const customLimiter = new RateLimiter({
        maxAttempts: 2,
        lockoutDurationMs: 5000, // 5 seconds
      });

      customLimiter.recordFailure('192.168.1.1');
      customLimiter.recordFailure('192.168.1.1');

      const result = customLimiter.check('192.168.1.1');
      expect(result.retryAfterMs).toBe(5000);
    });
  });
});
