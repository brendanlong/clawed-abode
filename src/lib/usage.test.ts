import { describe, it, expect } from 'vitest';
import type { RateLimitReading } from './rate-limit';
import {
  buildUsageReport,
  dueUsageAlerts,
  formatUsageAlert,
  markUsageAlertsSent,
  parseUsageSnapshot,
  sessionSubscriptionUsage,
  type ModelUsageWindow,
  type UsageAlertThresholds,
} from './usage';

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const IN_TWO_HOURS = NOW + 2 * 60 * 60 * 1000;
const IN_A_WEEK = NOW + 7 * 24 * 60 * 60 * 1000;

function reading(overrides: Partial<RateLimitReading> = {}): RateLimitReading {
  return {
    limitType: 'five_hour',
    rejected: false,
    authoritative: true,
    utilization: 50,
    resetsAtMs: IN_TWO_HOURS,
    ...overrides,
  };
}

const BOTH_AT_80: UsageAlertThresholds = { fiveHour: 80, weekly: 80 };

describe('dueUsageAlerts', () => {
  it('fires for a window at or past its threshold', () => {
    const at = reading({ utilization: 80 });
    const below = reading({ limitType: 'seven_day', utilization: 79.9, resetsAtMs: IN_A_WEEK });
    expect(dueUsageAlerts([at, below], BOTH_AT_80, new Map())).toEqual([at]);
  });

  it('uses the weekly threshold for every weekly window', () => {
    const opus = reading({ limitType: 'seven_day_opus', utilization: 60, resetsAtMs: IN_A_WEEK });
    expect(dueUsageAlerts([opus], { fiveHour: 90, weekly: 50 }, new Map())).toEqual([opus]);
    expect(dueUsageAlerts([opus], { fiveHour: 50, weekly: 90 }, new Map())).toEqual([]);
  });

  it('never fires for a kind of window whose alerts are off', () => {
    const full = reading({ utilization: 99 });
    expect(dueUsageAlerts([full], { fiveHour: null, weekly: 80 }, new Map())).toEqual([]);
  });

  it('fires for a rejected window even without a utilization figure', () => {
    const rejected = reading({ rejected: true, utilization: null });
    expect(dueUsageAlerts([rejected], BOTH_AT_80, new Map())).toEqual([rejected]);
  });

  it('fires once per window, and again once the window rolls over', () => {
    const first = reading({ utilization: 85 });
    const sent = markUsageAlertsSent(new Map(), [first]);
    expect(dueUsageAlerts([reading({ utilization: 95 })], BOTH_AT_80, sent)).toEqual([]);

    const sameWindowReportedLater = reading({ utilization: 95, resetsAtMs: IN_TWO_HOURS + 999 });
    expect(dueUsageAlerts([sameWindowReportedLater], BOTH_AT_80, sent)).toEqual([]);

    const nextWindow = reading({ utilization: 85, resetsAtMs: IN_TWO_HOURS + 5 * 3600_000 });
    expect(dueUsageAlerts([nextWindow], BOTH_AT_80, sent)).toEqual([nextWindow]);
  });
});

describe('formatUsageAlert', () => {
  it('says which windows crossed, how full they are, and when they reset', () => {
    const text = formatUsageAlert(
      [
        reading({ utilization: 82.4 }),
        reading({ limitType: 'seven_day', rejected: true, resetsAtMs: IN_A_WEEK }),
      ],
      NOW
    );
    expect(text).toContain('not written by the user');
    expect(text).toContain('5-hour limit is 82% used and resets in about 2 hours');
    expect(text).toContain('weekly limit is exhausted');
    expect(text).toContain('set_usage_alerts');
  });
});

describe('parseUsageSnapshot', () => {
  const snapshot = (rateLimits: unknown) => ({
    session: { total_cost_usd: 0 },
    subscription_type: 'max',
    rate_limits_available: rateLimits !== null,
    rate_limits: rateLimits,
    behaviors: null,
  });

  it('is null when the snapshot has no plan limits', () => {
    expect(parseUsageSnapshot(snapshot(null), NOW)).toBeNull();
    expect(parseUsageSnapshot('nonsense', NOW)).toBeNull();
  });

  it('reads percentages as percentages, including ones below 1', () => {
    const parsed = parseUsageSnapshot(
      snapshot({
        five_hour: { utilization: 0.5, resets_at: new Date(IN_TWO_HOURS).toISOString() },
        seven_day: { utilization: 42, resets_at: new Date(IN_A_WEEK).toISOString() },
      }),
      NOW
    );
    expect(parsed?.readings).toEqual([
      reading({ authoritative: false, utilization: 0.5 }),
      reading({
        limitType: 'seven_day',
        authoritative: false,
        utilization: 42,
        resetsAtMs: IN_A_WEEK,
      }),
    ]);
  });

  it('skips windows that are missing, undated, past, or of an unknown type', () => {
    const parsed = parseUsageSnapshot(
      snapshot({
        five_hour: null,
        seven_day: { utilization: 10, resets_at: null },
        seven_day_opus: { utilization: 10, resets_at: new Date(NOW - 1000).toISOString() },
        seven_day_oauth_apps: { utilization: 10, resets_at: new Date(IN_A_WEEK).toISOString() },
      }),
      NOW
    );
    expect(parsed?.readings).toEqual([]);
  });

  it('keeps per-model windows and extra usage', () => {
    const parsed = parseUsageSnapshot(
      snapshot({
        model_scoped: [
          { display_name: 'Fable', utilization: 12, resets_at: new Date(IN_A_WEEK).toISOString() },
        ],
        extra_usage: {
          is_enabled: true,
          monthly_limit: 50,
          used_credits: 5,
          utilization: 10,
          currency: 'USD',
        },
      }),
      NOW
    );
    expect(parsed?.modelWindows).toEqual([
      { name: 'Fable', percentUsed: 12, resetsAtMs: IN_A_WEEK },
    ]);
    expect(parsed?.extraUsage).toEqual({
      enabled: true,
      monthlyLimit: 50,
      usedCredits: 5,
      percentUsed: 10,
      currency: 'USD',
    });
  });
});

describe('buildUsageReport', () => {
  it('reports each window with when it resets, plus the session’s alert settings', () => {
    const report = buildUsageReport({
      readings: [reading({ utilization: 61.6 })],
      observedAtMs: NOW - 60_000,
      extras: null,
      thresholds: { fiveHour: 80, weekly: null },
      nowMs: NOW,
    });
    expect(report).toEqual({
      asOf: new Date(NOW - 60_000).toISOString(),
      windows: [
        {
          window: '5-hour limit',
          limitType: 'five_hour',
          percentUsed: 62,
          exhausted: false,
          resetsAt: new Date(IN_TWO_HOURS).toISOString(),
          resetsIn: 'in about 2 hours',
        },
      ],
      alerts: { fiveHourPercent: 80, weeklyPercent: null },
    });
  });
});

describe('sessionSubscriptionUsage', () => {
  const fiveHour = reading({ utilization: 58 });
  const weekly = reading({ limitType: 'seven_day', utilization: 44, resetsAtMs: IN_A_WEEK });
  const fable: ModelUsageWindow = { name: 'Fable', percentUsed: 86, resetsAtMs: IN_A_WEEK };

  function usageFor(
    model: string | null,
    modelWindows: ModelUsageWindow[] = [fable],
    readings: RateLimitReading[] = [fiveHour, weekly]
  ) {
    return sessionSubscriptionUsage({ readings, modelWindows, model, nowMs: NOW });
  }

  it('shows the 5-hour window and the model-scoped weekly window for a matching model', () => {
    expect(usageFor('claude-fable-5-1[1m]')).toEqual({
      fiveHour: { label: 'Session', percentUsed: 58, exhausted: false, resetsAtMs: IN_TWO_HOURS },
      weeklyModel: {
        label: 'Weekly (Fable)',
        percentUsed: 86,
        exhausted: false,
        resetsAtMs: IN_A_WEEK,
      },
      weeklyAllModels: {
        label: 'Weekly (all models)',
        percentUsed: 44,
        exhausted: false,
        resetsAtMs: IN_A_WEEK,
      },
    });
  });

  it('matches model aliases case-insensitively', () => {
    expect(usageFor('FABLE').weeklyModel?.percentUsed).toBe(86);
  });

  it('has no model-scoped window for a model without one', () => {
    const usage = usageFor('claude-sonnet-5-5');
    expect(usage.weeklyModel).toBeNull();
    expect(usage.weeklyAllModels).toEqual({
      label: 'Weekly',
      percentUsed: 44,
      exhausted: false,
      resetsAtMs: IN_A_WEEK,
    });
  });

  it('has no model-scoped window when the model is unknown', () => {
    expect(usageFor(null).weeklyModel).toBeNull();
  });

  it('uses a per-model rate-limit reading, which knows about exhaustion', () => {
    const opus = reading({ limitType: 'seven_day_opus', rejected: true, resetsAtMs: IN_A_WEEK });
    expect(usageFor('claude-opus-5-5', [], [fiveHour, weekly, opus]).weeklyModel).toEqual({
      label: 'Weekly (Opus)',
      percentUsed: 50,
      exhausted: true,
      resetsAtMs: IN_A_WEEK,
    });
  });

  it('ignores a model-scoped window that has already reset', () => {
    expect(usageFor('fable', [{ ...fable, resetsAtMs: NOW - 1 }]).weeklyModel).toBeNull();
  });

  it('is empty without readings', () => {
    expect(usageFor('fable', [], [])).toEqual({
      fiveHour: null,
      weeklyAllModels: null,
      weeklyModel: null,
    });
  });
});
