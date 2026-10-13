/**
 * Pure logic behind the agents' usage tools: parsing the SDK's experimental
 * `/usage` snapshot, deciding which usage alerts are due, and the text agents
 * read. The readings themselves are the rate-limit pause's (src/lib/rate-limit.ts).
 * Rationale: doc/rate-limit-pause.md "Usage Tools".
 */

import { z } from 'zod';
import {
  describeLimitType,
  formatTimeUntil,
  HOLDABLE_LIMIT_TYPES,
  MAX_PAUSE_THRESHOLD,
  sameWindow,
  type HoldableLimitType,
  type RateLimitReading,
} from './rate-limit';

export const DEFAULT_USAGE_ALERT_PERCENT = 80;
export const usageAlertPercentSchema = z.number().int().min(1).max(100);

/** A session's alert thresholds, in percent used; null turns off alerts for that kind of window. */
export interface UsageAlertThresholds {
  fiveHour: number | null;
  /** Applies to every weekly window (overall and per-model). */
  weekly: number | null;
}

/** Which window each alert last fired for: the window's `resetsAtMs`, by window. */
export type SentUsageAlerts = ReadonlyMap<HoldableLimitType, number>;

function alertThreshold(
  limitType: HoldableLimitType,
  thresholds: UsageAlertThresholds
): number | null {
  return limitType === 'five_hour' ? thresholds.fiveHour : thresholds.weekly;
}

/**
 * Readings at or past the session's threshold that haven't been alerted in their
 * current window. A rejection counts as past any threshold, since a rejected
 * window often reports no utilization at all.
 */
export function dueUsageAlerts(
  readings: readonly RateLimitReading[],
  thresholds: UsageAlertThresholds,
  sent: SentUsageAlerts
): RateLimitReading[] {
  return readings.filter((reading) => {
    const threshold = alertThreshold(reading.limitType, thresholds);
    const sentFor = sent.get(reading.limitType);
    if (threshold === null || (sentFor !== undefined && sameWindow(sentFor, reading.resetsAtMs))) {
      return false;
    }
    return reading.rejected || (reading.utilization !== null && reading.utilization >= threshold);
  });
}

/** Mark readings as alerted for their current window. Pure. */
export function markUsageAlertsSent(
  sent: SentUsageAlerts,
  readings: readonly RateLimitReading[]
): Map<HoldableLimitType, number> {
  const next = new Map(sent);
  for (const reading of readings) next.set(reading.limitType, reading.resetsAtMs);
  return next;
}

function describeReading(reading: RateLimitReading, nowMs: number): string {
  const used = reading.rejected
    ? 'is exhausted (the API is refusing requests against it)'
    : `is ${Math.round(reading.utilization ?? 0)}% used`;
  return `The ${describeLimitType(reading.limitType)} ${used} and resets ${formatTimeUntil(reading.resetsAtMs, nowMs)}.`;
}

/** The message a session receives when alerts come due. */
export function formatUsageAlert(due: readonly RateLimitReading[], nowMs: number): string {
  const lines = due.map((reading) => describeReading(reading, nowMs));
  return `[Usage alert from Clawed Abode, not written by the user.] ${lines.join(' ')} Plan how much more work to hand to subagents accordingly; check_usage shows every window, and set_usage_alerts changes or turns off these alerts.`;
}

export interface ModelUsageWindow {
  name: string;
  percentUsed: number | null;
  resetsAtMs: number | null;
}

export interface ExtraUsage {
  enabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  percentUsed: number | null;
  currency: string | null;
}

/** What the `/usage` snapshot adds beyond the rate-limit readings. */
export interface UsageSnapshot {
  readings: RateLimitReading[];
  modelWindows: ModelUsageWindow[];
  extraUsage: ExtraUsage | null;
}

/**
 * The snapshot's percentages are 0-100, unlike the rate-limit events' fractions,
 * so a small figure like 0.5% must not go through `normalizeUtilization`.
 */
function snapshotPercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(MAX_PAUSE_THRESHOLD, value);
}

function snapshotResetsAt(value: string | null | undefined): number | null {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

const SnapshotWindowSchema = z
  .object({ utilization: z.number().nullish(), resets_at: z.string().nullish() })
  .nullish();

/**
 * `SDKControlGetUsageResponse`, parsed defensively: the SDK marks the call
 * experimental and says the shape may change, so only the fields used here are
 * required to look right, and everything else is ignored.
 */
const UsageSnapshotSchema = z.object({
  rate_limits: z
    .object({
      model_scoped: z
        .array(
          z.object({
            display_name: z.string(),
            utilization: z.number().nullish(),
            resets_at: z.string().nullish(),
          })
        )
        .nullish(),
      extra_usage: z
        .object({
          is_enabled: z.boolean(),
          monthly_limit: z.number().nullish(),
          used_credits: z.number().nullish(),
          utilization: z.number().nullish(),
          currency: z.string().nullish(),
        })
        .nullish(),
    })
    .catchall(z.unknown())
    .nullish(),
});

/**
 * The usable parts of a `/usage` snapshot, or null when it carries no plan
 * limits (`rate_limits` is null for API keys, third-party providers, and OAuth
 * tokens without the `user:profile` scope, which includes `claude setup-token`
 * tokens) or doesn't parse. Its windows become usage-only readings: the snapshot
 * says nothing authoritative about whether the API is refusing requests.
 */
export function parseUsageSnapshot(raw: unknown, nowMs: number): UsageSnapshot | null {
  const parsed = UsageSnapshotSchema.safeParse(raw);
  const limits = parsed.success ? parsed.data.rate_limits : null;
  if (!limits) return null;

  const readings: RateLimitReading[] = [];
  for (const limitType of HOLDABLE_LIMIT_TYPES) {
    const window = SnapshotWindowSchema.safeParse(limits[limitType]);
    if (!window.success || !window.data) continue;
    const utilization = snapshotPercent(window.data.utilization);
    const resetsAtMs = snapshotResetsAt(window.data.resets_at);
    if (utilization === null || resetsAtMs === null || resetsAtMs <= nowMs) continue;
    readings.push({ limitType, rejected: false, authoritative: false, utilization, resetsAtMs });
  }

  const extra = limits.extra_usage;
  return {
    readings,
    modelWindows: (limits.model_scoped ?? []).map((w) => ({
      name: w.display_name,
      percentUsed: snapshotPercent(w.utilization),
      resetsAtMs: snapshotResetsAt(w.resets_at),
    })),
    extraUsage: extra
      ? {
          enabled: extra.is_enabled,
          monthlyLimit: extra.monthly_limit ?? null,
          usedCredits: extra.used_credits ?? null,
          percentUsed: snapshotPercent(extra.utilization),
          currency: extra.currency ?? null,
        }
      : null,
  };
}

function resetFields(resetsAtMs: number | null, nowMs: number) {
  return resetsAtMs === null
    ? { resetsAt: null, resetsIn: null }
    : {
        resetsAt: new Date(resetsAtMs).toISOString(),
        resetsIn: formatTimeUntil(resetsAtMs, nowMs),
      };
}

/** What check_usage returns. Plain data, so the tool can hand the agent JSON. */
export function buildUsageReport(input: {
  readings: readonly RateLimitReading[];
  observedAtMs: number | null;
  extras: (Omit<UsageSnapshot, 'readings'> & { fetchedAtMs: number }) | null;
  thresholds: UsageAlertThresholds;
  nowMs: number;
}) {
  const { readings, observedAtMs, extras, thresholds, nowMs } = input;
  return {
    asOf: observedAtMs === null ? null : new Date(observedAtMs).toISOString(),
    windows: readings.map((r) => ({
      window: describeLimitType(r.limitType),
      limitType: r.limitType,
      percentUsed: r.utilization === null ? null : Math.round(r.utilization),
      exhausted: r.rejected,
      ...resetFields(r.resetsAtMs, nowMs),
    })),
    ...(extras && {
      modelWindows: extras.modelWindows.map((w) => ({
        window: `weekly ${w.name} limit`,
        percentUsed: w.percentUsed === null ? null : Math.round(w.percentUsed),
        ...resetFields(w.resetsAtMs, nowMs),
      })),
      extraUsage: extras.extraUsage,
      snapshotAsOf: new Date(extras.fetchedAtMs).toISOString(),
    }),
    alerts: {
      fiveHourPercent: thresholds.fiveHour,
      weeklyPercent: thresholds.weekly,
    },
  };
}
