import { describe, it, expect } from 'vitest';
import {
  activeReadings,
  clampThreshold,
  decideHold,
  describeLimitType,
  formatTimeUntil,
  holdsEqual,
  mergeReading,
  nextReadingExpiry,
  normalizeResetsAt,
  normalizeUtilization,
  parseRateLimitEvent,
  resolvePausePolicy,
  UNKNOWN_RESET_HOLD_MS,
  type RateLimitReading,
} from './rate-limit';

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);
const IN_AN_HOUR = NOW + 60 * 60 * 1000;
const IN_A_WEEK = NOW + 7 * 24 * 60 * 60 * 1000;

function reading(overrides: Partial<RateLimitReading> = {}): RateLimitReading {
  return {
    limitType: 'five_hour',
    rejected: false,
    authoritative: true,
    utilization: 50,
    resetsAtMs: IN_AN_HOUR,
    ...overrides,
  };
}

/** Shaped like the real events in production (see the samples in rate-limit.ts). */
const rateLimitEvent = (info: Record<string, unknown>) => ({
  type: 'rate_limit_event',
  uuid: 'u',
  session_id: 's',
  rate_limit_info: info,
});

describe('normalizeResetsAt', () => {
  it('treats a small number as unix seconds', () => {
    expect(normalizeResetsAt(IN_AN_HOUR / 1000)).toBe(IN_AN_HOUR);
  });

  it('passes a millisecond timestamp through', () => {
    expect(normalizeResetsAt(IN_AN_HOUR)).toBe(IN_AN_HOUR);
  });

  it('rejects missing and nonsensical values', () => {
    expect(normalizeResetsAt(undefined)).toBeNull();
    expect(normalizeResetsAt(null)).toBeNull();
    expect(normalizeResetsAt(0)).toBeNull();
    expect(normalizeResetsAt(-5)).toBeNull();
    expect(normalizeResetsAt(NaN)).toBeNull();
  });
});

describe('normalizeUtilization', () => {
  it('scales the fraction the SDK actually sends into a percentage', () => {
    expect(normalizeUtilization(0.78)).toBe(78);
    expect(normalizeUtilization(1)).toBe(100);
    expect(normalizeUtilization(0)).toBe(0);
  });

  it('passes a value above 1 through as an already-percentage figure', () => {
    expect(normalizeUtilization(58)).toBe(58);
    expect(normalizeUtilization(500)).toBe(100);
  });

  it('rejects missing and nonsensical values', () => {
    expect(normalizeUtilization(undefined)).toBeNull();
    expect(normalizeUtilization(null)).toBeNull();
    expect(normalizeUtilization(-1)).toBeNull();
    expect(normalizeUtilization(NaN)).toBeNull();
  });
});

describe('parseRateLimitEvent', () => {
  it('parses a rejection with a reset time', () => {
    expect(
      parseRateLimitEvent(
        rateLimitEvent({
          status: 'rejected',
          rateLimitType: 'five_hour',
          resetsAt: IN_AN_HOUR / 1000,
        }),
        NOW
      )
    ).toEqual([
      {
        limitType: 'five_hour',
        rejected: true,
        authoritative: true,
        utilization: null,
        resetsAtMs: IN_AN_HOUR,
      },
    ]);
  });

  it('dates a rejection with no reset time so it expires on its own', () => {
    expect(
      parseRateLimitEvent(
        rateLimitEvent({ status: 'rejected', rateLimitType: 'seven_day' }),
        NOW
      )[0]
    ).toMatchObject({ rejected: true, resetsAtMs: NOW + UNKNOWN_RESET_HOLD_MS });
  });

  it('applies the same fallback when the reported reset is already past', () => {
    expect(
      parseRateLimitEvent(
        rateLimitEvent({
          status: 'rejected',
          rateLimitType: 'five_hour',
          resetsAt: (NOW - 1) / 1000,
        }),
        NOW
      )[0].resetsAtMs
    ).toBe(NOW + UNKNOWN_RESET_HOLD_MS);
  });

  // Verified against real events: a plain `allowed` carries no top-level
  // utilization at all, and every window's usage rides in `unifiedWindows`.
  it('reads every window out of unifiedWindows, only the stated one authoritative', () => {
    const readings = parseRateLimitEvent(
      rateLimitEvent({
        status: 'allowed',
        rateLimitType: 'five_hour',
        resetsAt: IN_AN_HOUR / 1000,
        unifiedWindows: {
          five_hour: { utilization: 0.78, resetsAt: IN_AN_HOUR / 1000 },
          seven_day: { utilization: 0.66, resetsAt: IN_A_WEEK / 1000 },
        },
      }),
      NOW
    );
    expect(readings).toEqual([
      {
        limitType: 'seven_day',
        rejected: false,
        authoritative: false,
        utilization: 66,
        resetsAtMs: IN_A_WEEK,
      },
      {
        limitType: 'five_hour',
        rejected: false,
        authoritative: true,
        utilization: 78,
        resetsAtMs: IN_AN_HOUR,
      },
    ]);
  });

  it('fills the stated window from unifiedWindows when the top level omits usage', () => {
    const [reading] = parseRateLimitEvent(
      rateLimitEvent({
        status: 'rejected',
        rateLimitType: 'seven_day_overage_included',
        resetsAt: IN_A_WEEK / 1000,
        unifiedWindows: {
          seven_day_overage_included: { utilization: 1, resetsAt: IN_A_WEEK / 1000 },
        },
      }),
      NOW
    );
    expect(reading).toMatchObject({ rejected: true, authoritative: true, utilization: 100 });
  });

  it('prefers the top-level utilization over the unifiedWindows copy', () => {
    const [reading] = parseRateLimitEvent(
      rateLimitEvent({
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        resetsAt: IN_AN_HOUR / 1000,
        utilization: 0.92,
        unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: IN_AN_HOUR / 1000 } },
      }),
      NOW
    );
    expect(reading.utilization).toBe(92);
  });

  it('drops an undated non-rejection (nothing to hold until)', () => {
    expect(
      parseRateLimitEvent(
        rateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4 }),
        NOW
      )
    ).toEqual([]);
  });

  it('drops windows we never hold for, including from unifiedWindows', () => {
    expect(
      parseRateLimitEvent(
        rateLimitEvent({
          status: 'rejected',
          rateLimitType: 'overage',
          resetsAt: IN_AN_HOUR / 1000,
          unifiedWindows: { overage: { utilization: 1, resetsAt: IN_AN_HOUR / 1000 } },
        }),
        NOW
      )
    ).toEqual([]);
  });

  // Production has 8 of these; with no window they can't be attributed anywhere.
  it('drops an event with no window type', () => {
    expect(parseRateLimitEvent(rateLimitEvent({ status: 'rejected' }), NOW)).toEqual([]);
  });

  it('drops non-events', () => {
    expect(parseRateLimitEvent({ type: 'result', subtype: 'success' }, NOW)).toEqual([]);
    expect(parseRateLimitEvent(null, NOW)).toEqual([]);
    expect(parseRateLimitEvent('nope', NOW)).toEqual([]);
  });

  it('drops a malformed payload rather than throwing', () => {
    expect(
      parseRateLimitEvent(rateLimitEvent({ status: 7, rateLimitType: 'five_hour' }), NOW)
    ).toEqual([]);
    expect(parseRateLimitEvent({ type: 'rate_limit_event' }, NOW)).toEqual([]);
  });
});

describe('mergeReading', () => {
  it('keeps one entry per window, newest wins', () => {
    const first = reading({ utilization: 50 });
    const second = reading({ utilization: 90 });
    expect(mergeReading([first], second, NOW)).toEqual([second]);
  });

  it('keeps other windows and drops expired ones', () => {
    const stale = reading({ limitType: 'seven_day_opus', resetsAtMs: NOW - 1 });
    const weekly = reading({ limitType: 'seven_day', resetsAtMs: IN_A_WEEK });
    const merged = mergeReading([stale, weekly], reading(), NOW);
    expect(merged.map((r) => r.limitType)).toEqual(['five_hour', 'seven_day']);
  });

  it('does not let a usage-only reading clear a live rejection', () => {
    const rejected = reading({ rejected: true, utilization: 100 });
    const usageOnly = reading({ authoritative: false, utilization: 40 });
    expect(mergeReading([rejected], usageOnly, NOW)[0]).toMatchObject({
      rejected: true,
      utilization: 40,
    });
  });

  it('lets an authoritative reading clear a rejection', () => {
    const rejected = reading({ rejected: true });
    expect(mergeReading([rejected], reading({ utilization: 20 }), NOW)[0].rejected).toBe(false);
  });

  it('drops an inherited rejection once the window has rolled over', () => {
    const rejected = reading({ rejected: true });
    const nextWindow = reading({ authoritative: false, resetsAtMs: IN_A_WEEK });
    expect(mergeReading([rejected], nextWindow, NOW)[0].rejected).toBe(false);
  });
});

describe('activeReadings / nextReadingExpiry', () => {
  it('filters out rolled-over windows', () => {
    const expired = reading({ limitType: 'seven_day', resetsAtMs: NOW });
    expect(activeReadings([reading(), expired], NOW)).toEqual([reading()]);
  });

  it('reports the earliest active reset', () => {
    const weekly = reading({ limitType: 'seven_day', resetsAtMs: IN_A_WEEK });
    expect(nextReadingExpiry([weekly, reading()], NOW)).toBe(IN_AN_HOUR);
    expect(nextReadingExpiry([], NOW)).toBeNull();
  });
});

describe('resolvePausePolicy', () => {
  const global = { enabled: true, threshold: 95 };

  it('inherits both fields when the session sets neither', () => {
    expect(resolvePausePolicy({ enabled: null, threshold: null }, global)).toEqual(global);
  });

  it('resolves the two fields independently', () => {
    expect(resolvePausePolicy({ enabled: null, threshold: 50 }, global)).toEqual({
      enabled: true,
      threshold: 50,
    });
    expect(resolvePausePolicy({ enabled: false, threshold: null }, global)).toEqual({
      enabled: false,
      threshold: 95,
    });
  });

  it('lets a session opt in while the global default is off', () => {
    expect(
      resolvePausePolicy({ enabled: true, threshold: 50 }, { enabled: false, threshold: 95 })
    ).toEqual({ enabled: true, threshold: 50 });
  });

  it('clamps an out-of-range stored threshold', () => {
    expect(resolvePausePolicy({ enabled: null, threshold: 0 }, global).threshold).toBe(1);
    expect(resolvePausePolicy({ enabled: null, threshold: 500 }, global).threshold).toBe(100);
  });
});

describe('clampThreshold', () => {
  it('bounds and rounds', () => {
    expect(clampThreshold(50.4)).toBe(50);
    expect(clampThreshold(-3)).toBe(1);
    expect(clampThreshold(1000)).toBe(100);
    expect(clampThreshold(NaN)).toBe(95);
  });
});

describe('decideHold', () => {
  const on = { enabled: true, threshold: 95 };

  it('never holds a session with pausing disabled, even on a rejection', () => {
    const rejected = reading({ rejected: true, utilization: 100 });
    expect(decideHold([rejected], { enabled: false, threshold: 95 }, NOW)).toBeNull();
  });

  it('holds until reset on a rejection', () => {
    const rejected = reading({ rejected: true, utilization: 100 });
    expect(decideHold([rejected], on, NOW)).toEqual({
      untilMs: IN_AN_HOUR,
      limitType: 'five_hour',
      reason: 'rejected',
      utilization: 100,
    });
  });

  it('holds on a weekly rejection even though the threshold ignores weekly', () => {
    const weekly = reading({ limitType: 'seven_day', rejected: true, resetsAtMs: IN_A_WEEK });
    expect(decideHold([weekly], on, NOW)).toMatchObject({
      untilMs: IN_A_WEEK,
      reason: 'rejected',
    });
  });

  it('holds pre-emptively at or above the 5-hour threshold', () => {
    expect(decideHold([reading({ utilization: 95 })], on, NOW)).toMatchObject({
      reason: 'threshold',
      untilMs: IN_AN_HOUR,
    });
    expect(decideHold([reading({ utilization: 94.9 })], on, NOW)).toBeNull();
  });

  it('honours a lower per-session threshold', () => {
    const half = reading({ utilization: 60 });
    expect(decideHold([half], { enabled: true, threshold: 50 }, NOW)).toMatchObject({
      reason: 'threshold',
    });
    expect(decideHold([half], on, NOW)).toBeNull();
  });

  it('never applies the threshold to a weekly window', () => {
    const weekly = reading({ limitType: 'seven_day', utilization: 99, resetsAtMs: IN_A_WEEK });
    expect(decideHold([weekly], on, NOW)).toBeNull();
  });

  it('ignores a utilization reading with no figure', () => {
    expect(decideHold([reading({ utilization: null })], on, NOW)).toBeNull();
  });

  it('picks the window that releases last', () => {
    const hourly = reading({ rejected: true });
    const weekly = reading({ limitType: 'seven_day', rejected: true, resetsAtMs: IN_A_WEEK });
    expect(decideHold([hourly, weekly], on, NOW)).toMatchObject({
      limitType: 'seven_day',
      untilMs: IN_A_WEEK,
    });
  });

  it('ignores readings whose window has already rolled over', () => {
    const stale = reading({ rejected: true, resetsAtMs: NOW });
    expect(decideHold([stale], on, NOW)).toBeNull();
  });
});

describe('holdsEqual', () => {
  const hold = {
    untilMs: IN_AN_HOUR,
    limitType: 'five_hour' as const,
    reason: 'rejected' as const,
  };

  it('compares by release time, window and reason', () => {
    expect(holdsEqual(null, null)).toBe(true);
    expect(holdsEqual(null, { ...hold, utilization: null })).toBe(false);
    expect(holdsEqual({ ...hold, utilization: 100 }, { ...hold, utilization: 99 })).toBe(true);
    expect(
      holdsEqual({ ...hold, utilization: null }, { ...hold, untilMs: IN_A_WEEK, utilization: null })
    ).toBe(false);
  });
});

describe('describeLimitType', () => {
  it('labels known windows and humanizes unknown ones', () => {
    expect(describeLimitType('five_hour')).toBe('5-hour limit');
    expect(describeLimitType('seven_day')).toBe('weekly limit');
    expect(describeLimitType('some_future_window')).toBe('some future window');
  });
});

describe('formatTimeUntil', () => {
  it('uses the coarsest unit that still reads precisely', () => {
    expect(formatTimeUntil(NOW + 60_000, NOW)).toBe('in 1 minute');
    expect(formatTimeUntil(NOW + 42 * 60_000, NOW)).toBe('in 42 minutes');
    expect(formatTimeUntil(NOW + 3 * 60 * 60_000, NOW)).toBe('in about 3 hours');
    expect(formatTimeUntil(NOW + 47 * 60 * 60_000, NOW)).toBe('in about 2 days');
  });

  it('does not go negative once the window has passed', () => {
    expect(formatTimeUntil(NOW - 1000, NOW)).toBe('any moment now');
  });
});
