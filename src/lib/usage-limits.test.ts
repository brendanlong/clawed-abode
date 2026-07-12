import { describe, it, expect } from 'vitest';
import {
  usageResponseSchema,
  organizationsResponseSchema,
  selectUsageLimits,
  scopeMatchesModel,
  type UsageLimit,
} from './usage-limits';

// The example response from issue #379, trimmed to the fields we parse.
const ISSUE_EXAMPLE_LIMITS: UsageLimit[] = [
  {
    kind: 'session',
    group: 'session',
    percent: 58,
    severity: 'normal',
    resets_at: '2026-07-03T05:00:00.050706+00:00',
    scope: null,
    is_active: false,
  },
  {
    kind: 'weekly_all',
    group: 'weekly',
    percent: 44,
    severity: 'normal',
    resets_at: '2026-07-07T13:00:00.050731+00:00',
    scope: null,
    is_active: false,
  },
  {
    kind: 'weekly_scoped',
    group: 'weekly',
    percent: 86,
    severity: 'warning',
    resets_at: '2026-07-07T13:00:00.051043+00:00',
    scope: { model: { id: null, display_name: 'Fable' } },
    is_active: true,
  },
];

describe('usageResponseSchema', () => {
  it('parses the issue #379 example response, ignoring unknown fields', () => {
    const raw = {
      five_hour: { utilization: 58.0, resets_at: '2026-07-03T05:00:00+00:00' },
      seven_day: { utilization: 44.0 },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
      limits: [
        {
          kind: 'session',
          group: 'session',
          percent: 58,
          severity: 'normal',
          resets_at: '2026-07-03T05:00:00.050706+00:00',
          scope: null,
          is_active: false,
        },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 86,
          severity: 'warning',
          resets_at: '2026-07-07T13:00:00.051043+00:00',
          scope: { model: { id: null, display_name: 'Fable' }, surface: null },
          is_active: true,
        },
      ],
      spend: { percent: 43 },
    };

    const parsed = usageResponseSchema.parse(raw);
    expect(parsed.limits).toHaveLength(2);
    expect(parsed.limits[0].group).toBe('session');
    expect(parsed.limits[1].scope?.model?.display_name).toBe('Fable');
  });

  it('defaults limits to an empty array when missing', () => {
    expect(usageResponseSchema.parse({}).limits).toEqual([]);
  });
});

describe('organizationsResponseSchema', () => {
  it('parses an org list, defaulting capabilities', () => {
    const parsed = organizationsResponseSchema.parse([
      { uuid: 'org-1', name: 'ignored', capabilities: ['chat', 'claude_pro'] },
      { uuid: 'org-2' },
    ]);
    expect(parsed[0].uuid).toBe('org-1');
    expect(parsed[1].capabilities).toEqual([]);
  });
});

describe('scopeMatchesModel', () => {
  it('matches a display_name substring of the model id', () => {
    const scope = { model: { id: null, display_name: 'Fable' } };
    expect(scopeMatchesModel(scope, 'claude-fable-5')).toBe(true);
    expect(scopeMatchesModel(scope, 'claude-fable-5-20260203')).toBe(true);
  });

  it('matches a bare alias in either direction', () => {
    const scope = { model: { id: null, display_name: 'Fable' } };
    expect(scopeMatchesModel(scope, 'fable')).toBe(true);
  });

  it('matches on scope model id when present', () => {
    const scope = { model: { id: 'claude-opus-4-8', display_name: 'Opus' } };
    expect(scopeMatchesModel(scope, 'claude-opus-4-8')).toBe(true);
  });

  it('does not match a different model', () => {
    const scope = { model: { id: null, display_name: 'Fable' } };
    expect(scopeMatchesModel(scope, 'claude-opus-4-8')).toBe(false);
    expect(scopeMatchesModel(scope, 'claude-sonnet-4-6')).toBe(false);
  });

  it('returns false without a model scope or active model', () => {
    expect(scopeMatchesModel(null, 'claude-fable-5')).toBe(false);
    expect(scopeMatchesModel({ model: null }, 'claude-fable-5')).toBe(false);
    expect(scopeMatchesModel({ model: { id: null, display_name: 'Fable' } }, null)).toBe(false);
  });
});

describe('selectUsageLimits', () => {
  it('picks the scoped weekly limit when the active model matches', () => {
    const bars = selectUsageLimits(ISSUE_EXAMPLE_LIMITS, 'claude-fable-5');
    expect(bars).toEqual([
      {
        key: 'session',
        label: 'Session',
        percent: 58,
        severity: 'normal',
        resetsAt: '2026-07-03T05:00:00.050706+00:00',
      },
      {
        key: 'weekly',
        label: 'Weekly (Fable)',
        percent: 86,
        severity: 'warning',
        resetsAt: '2026-07-07T13:00:00.051043+00:00',
      },
    ]);
  });

  it('falls back to the all-models weekly limit for other models', () => {
    const bars = selectUsageLimits(ISSUE_EXAMPLE_LIMITS, 'claude-opus-4-8');
    expect(bars.map((b) => [b.key, b.percent])).toEqual([
      ['session', 58],
      ['weekly', 44],
    ]);
    expect(bars[1].label).toBe('Weekly');
  });

  it('uses the all-models weekly limit when the active model is unknown', () => {
    const bars = selectUsageLimits(ISSUE_EXAMPLE_LIMITS, null);
    expect(bars[1].percent).toBe(44);
  });

  it('omits missing groups', () => {
    expect(selectUsageLimits([], 'claude-fable-5')).toEqual([]);
    const sessionOnly = selectUsageLimits([ISSUE_EXAMPLE_LIMITS[0]], null);
    expect(sessionOnly.map((b) => b.key)).toEqual(['session']);
  });

  it('normalizes unknown severities to exceeded and missing ones to normal', () => {
    const limits: UsageLimit[] = [
      {
        kind: 'session',
        group: 'session',
        percent: 101,
        severity: 'exceeded',
        resets_at: null,
        scope: null,
        is_active: true,
      },
      {
        kind: 'weekly_all',
        group: 'weekly',
        percent: 10,
        severity: null,
        resets_at: null,
        scope: null,
        is_active: false,
      },
    ];
    const bars = selectUsageLimits(limits, null);
    expect(bars[0].severity).toBe('exceeded');
    expect(bars[1].severity).toBe('normal');
  });
});
