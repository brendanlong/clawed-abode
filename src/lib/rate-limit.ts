/**
 * Pure logic for the subscription rate-limit pause: parsing the SDK's rate-limit
 * signals into per-window readings, and deciding — per session, under that
 * session's policy — whether to hold work until the window resets.
 *
 * Readings are account-wide (one subscription, one budget); the *policy* is
 * per-session, so a low-priority session can pause at 50% of the 5-hour window
 * while an urgent one keeps running (and spends overage credits) on the same
 * readings. Rationale and the resolution order live in doc/rate-limit-pause.md.
 *
 * Everything comes from `rate_limit_event` messages on the sessions' streams.
 * Their shape was verified against the ~8.8k real events in this app's production
 * database, which is where several of the rules below come from — the SDK's
 * `SDKRateLimitInfo` type documents neither the units nor the `unifiedWindows`
 * field, so reading the type alone gets both wrong.
 */

import { z } from 'zod';

/** Windows we will hold for. `overage` is paid credit, not a plan window. */
export const HOLDABLE_LIMIT_TYPES = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
] as const;
export type HoldableLimitType = (typeof HOLDABLE_LIMIT_TYPES)[number];

/**
 * The only window the utilization threshold applies to. The weekly windows are
 * deliberately excluded: a threshold there would permanently strand the last few
 * percent of a weekly allowance, and spending the week's budget is the whole
 * point — a week only holds once the API actually rejects a request.
 */
const THRESHOLD_LIMIT_TYPE: HoldableLimitType = 'five_hour';

/** Hold length used when a rejection arrives with no usable `resetsAt`. */
export const UNKNOWN_RESET_HOLD_MS = 15 * 60 * 1000;

/** Bounds for a configured threshold. 100 is effectively "only on rejection". */
export const MIN_PAUSE_THRESHOLD = 1;
export const MAX_PAUSE_THRESHOLD = 100;
export const DEFAULT_PAUSE_THRESHOLD = 95;

const LIMIT_TYPE_LABELS: Record<HoldableLimitType, string> = {
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'weekly Opus limit',
  seven_day_sonnet: 'weekly Sonnet limit',
  seven_day_overage_included: 'weekly limit',
};

export function describeLimitType(limitType: string): string {
  return LIMIT_TYPE_LABELS[limitType as HoldableLimitType] ?? limitType.replace(/_/g, ' ');
}

function isHoldableLimitType(value: string): value is HoldableLimitType {
  return (HOLDABLE_LIMIT_TYPES as readonly string[]).includes(value);
}

/**
 * One window's state. `resetsAtMs` is always known: it is both when the reading
 * stops being true and when a hold on it releases, so a reading we can't date is
 * unusable and is dropped at parse time rather than stored as an open question.
 */
export interface RateLimitReading {
  limitType: HoldableLimitType;
  /** True when the API is refusing requests against this window right now. */
  rejected: boolean;
  /**
   * Whether this reading is authoritative about {@link rejected} for its window.
   *
   * An event states a status for exactly one window (its `rateLimitType`) but
   * reports *usage* for several via `unifiedWindows`. Those extra readings say
   * nothing about refusal, so they must never clear a live rejection — otherwise
   * an unrelated `allowed` event for the 5-hour window would release a weekly
   * hold and push the queue back into a window the API is still refusing.
   */
  authoritative: boolean;
  /** Percentage of the window consumed, 0-100, when known. */
  utilization: number | null;
  /** Epoch milliseconds at which the window rolls over. */
  resetsAtMs: number;
}

/**
 * Epoch timestamps arrive as seconds from the SDK's rate-limit events and as ISO
 * strings from the `/usage` snapshot. Anything below this bound can only be a
 * seconds value (as milliseconds it would be 1970).
 */
const SECONDS_VS_MILLIS_BOUND = 1e12;

/**
 * Normalize an SDK `utilization` to a 0-100 percentage.
 *
 * Rate-limit events report a **fraction** — 0.78 means 78%, and every one of the
 * ~1000 utilization-bearing events in production is ≤ 1. Read as a percentage it
 * would make every threshold comparison silently never fire. Values above 1 are
 * taken as already being a percentage, so a future units change reads as
 * over-eager rather than as a permanent 0%.
 */
export function normalizeUtilization(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(MAX_PAUSE_THRESHOLD, value <= 1 ? value * 100 : value);
}

/** Normalize an SDK `resetsAt` (seconds or milliseconds) to epoch milliseconds. */
export function normalizeResetsAt(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value < SECONDS_VS_MILLIS_BOUND ? Math.round(value * 1000) : Math.round(value);
}

/**
 * An `SDKRateLimitEvent`, parsed defensively: the SDK marks most of these fields
 * optional, the shape mirrors a server response we don't control, and
 * `unifiedWindows` is absent from the type altogether. Unknown keys are ignored
 * and a bad payload yields nothing rather than throwing in the query loop.
 */
const UnifiedWindowSchema = z
  .object({ utilization: z.number().nullish(), resetsAt: z.number().nullish() })
  .nullish();

const RateLimitEventSchema = z.object({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.object({
    status: z.string(),
    resetsAt: z.number().nullish(),
    rateLimitType: z.string().nullish(),
    utilization: z.number().nullish(),
    /**
     * Every window's current usage, carried on nearly every event — undocumented,
     * and only emitted by recent CLI versions (it first appears in production in
     * September 2026). This is the only dependable source of a utilization
     * figure: the top-level `utilization` is populated on `allowed_warning`
     * events but null on the plain `allowed` ones that are ~87% of the stream,
     * and null on rejections. Without it the threshold pause has nothing to read
     * and only the `rejected` backstop applies.
     */
    unifiedWindows: z.record(z.string(), UnifiedWindowSchema).nullish(),
  }),
});

/**
 * Every usable reading in a `rate_limit_event`: the window the event states a
 * status for (authoritative), plus a usage-only reading for each other window in
 * `unifiedWindows`. Empty for anything that isn't a usable event. Windows we
 * never hold for (see {@link HOLDABLE_LIMIT_TYPES}) are dropped here so callers
 * need not know the policy.
 *
 * A reading must be datable — `resetsAtMs` is both when it stops being true and
 * when a hold on it releases — so undated ones are dropped. The exception is a
 * rejection, which is too important to discard: it is dated
 * {@link UNKNOWN_RESET_HOLD_MS} out so it expires on its own and the next attempt
 * re-learns the real reset. (Production has 8 such events, all with no window
 * type at all; those still can't be attributed to a window, so they are dropped.)
 */
export function parseRateLimitEvent(message: unknown, nowMs: number): RateLimitReading[] {
  if (
    typeof message !== 'object' ||
    message === null ||
    (message as { type?: unknown }).type !== 'rate_limit_event'
  ) {
    return [];
  }
  const parsed = RateLimitEventSchema.safeParse(message);
  if (!parsed.success) return [];
  const info = parsed.data.rate_limit_info;
  const statedType = info.rateLimitType;

  const readings: RateLimitReading[] = [];
  for (const [limitType, window] of Object.entries(info.unifiedWindows ?? {})) {
    if (!window || !isHoldableLimitType(limitType) || limitType === statedType) continue;
    const resetsAtMs = normalizeResetsAt(window.resetsAt);
    if (resetsAtMs === null || resetsAtMs <= nowMs) continue;
    readings.push({
      limitType,
      rejected: false,
      authoritative: false,
      utilization: normalizeUtilization(window.utilization),
      resetsAtMs,
    });
  }

  if (!statedType || !isHoldableLimitType(statedType)) return readings;

  const stated = info.unifiedWindows?.[statedType];
  const rejected = info.status === 'rejected';
  const resetsAt = normalizeResetsAt(info.resetsAt) ?? normalizeResetsAt(stated?.resetsAt);
  const resetsAtMs =
    resetsAt && resetsAt > nowMs ? resetsAt : rejected ? nowMs + UNKNOWN_RESET_HOLD_MS : null;
  if (resetsAtMs === null) return readings;

  readings.push({
    limitType: statedType,
    rejected,
    authoritative: true,
    utilization: normalizeUtilization(info.utilization ?? stated?.utilization),
    resetsAtMs,
  });
  return readings;
}

/**
 * Fold a reading into the known set: one entry per window, newest wins, expired
 * entries dropped. Pure — returns a new array, sorted by window for stable
 * comparison and display.
 *
 * A usage-only reading (see {@link RateLimitReading.authoritative}) updates the
 * numbers but **inherits a live rejection** rather than clearing it — it carries
 * no information about refusal. The inheritance stops at a window boundary: a
 * different `resetsAtMs` means the window has rolled over, so the old rejection
 * no longer describes it. Only an authoritative reading, or the reading expiring,
 * ends a rejection.
 */
export function mergeReading(
  readings: readonly RateLimitReading[],
  incoming: RateLimitReading,
  nowMs: number
): RateLimitReading[] {
  const byType = new Map(
    readings.filter((r) => r.resetsAtMs > nowMs).map((r) => [r.limitType, r] as const)
  );
  const existing = byType.get(incoming.limitType);
  const inheritsRejection =
    !incoming.authoritative &&
    existing?.rejected === true &&
    existing.resetsAtMs === incoming.resetsAtMs;

  byType.set(incoming.limitType, inheritsRejection ? { ...incoming, rejected: true } : incoming);
  return [...byType.values()].sort((a, b) => a.limitType.localeCompare(b.limitType));
}

/** Drop readings whose window has already rolled over. Pure. */
export function activeReadings(
  readings: readonly RateLimitReading[],
  nowMs: number
): RateLimitReading[] {
  return readings.filter((r) => r.resetsAtMs > nowMs);
}

/**
 * Earliest reset among the active readings — when the set next changes meaning
 * and holds must be recomputed. `null` when nothing is active.
 */
export function nextReadingExpiry(
  readings: readonly RateLimitReading[],
  nowMs: number
): number | null {
  const times = activeReadings(readings, nowMs).map((r) => r.resetsAtMs);
  return times.length > 0 ? Math.min(...times) : null;
}

/** A session's resolved pause policy. */
export interface PausePolicy {
  /** When false the session never pauses — it errors, or spends overage credits. */
  enabled: boolean;
  /** 5-hour-window utilization percent at which the session pre-emptively pauses. */
  threshold: number;
}

/** Layered pause settings, as stored (null at a layer means "inherit"). */
export interface PauseSettingsLayer {
  enabled: boolean | null;
  threshold: number | null;
}

/**
 * Resolve the effective pause policy: per-session override → global setting. The
 * two fields resolve independently, so a session can raise its threshold without
 * restating the global on/off (and vice versa).
 */
export function resolvePausePolicy(session: PauseSettingsLayer, global: PausePolicy): PausePolicy {
  return {
    enabled: session.enabled ?? global.enabled,
    threshold: clampThreshold(session.threshold ?? global.threshold),
  };
}

export function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PAUSE_THRESHOLD;
  return Math.min(MAX_PAUSE_THRESHOLD, Math.max(MIN_PAUSE_THRESHOLD, Math.round(value)));
}

/** Why a session is paused — drives the banner text and the resume nudge. */
export type HoldReason = 'rejected' | 'threshold';

export interface RateLimitHold {
  /** Epoch milliseconds at which this session's queued work is released. */
  untilMs: number;
  limitType: HoldableLimitType;
  reason: HoldReason;
  /** Window utilization when the hold was decided, when known. */
  utilization: number | null;
}

/**
 * Whether one reading holds a session under its policy, and until when. Pure.
 *
 * - A `rejected` reading holds for any window: the API is refusing requests, so
 *   the alternative is failing turns.
 * - A utilization reading holds only for the 5-hour window and only at or above
 *   the threshold — see {@link THRESHOLD_LIMIT_TYPE} for why weekly is excluded.
 */
function holdForReading(
  reading: RateLimitReading,
  policy: PausePolicy,
  nowMs: number
): RateLimitHold | null {
  if (reading.resetsAtMs <= nowMs) return null;
  const base = { untilMs: reading.resetsAtMs, limitType: reading.limitType };

  if (reading.rejected) {
    return { ...base, reason: 'rejected', utilization: reading.utilization };
  }
  if (reading.limitType !== THRESHOLD_LIMIT_TYPE) return null;
  if (reading.utilization === null || reading.utilization < policy.threshold) return null;
  return { ...base, reason: 'threshold', utilization: reading.utilization };
}

/**
 * The hold in effect for a session, or `null` when it may keep working. When more
 * than one window holds, the one that releases last wins — releasing earlier would
 * push work straight back into a window that is still exhausted.
 */
export function decideHold(
  readings: readonly RateLimitReading[],
  policy: PausePolicy,
  nowMs: number
): RateLimitHold | null {
  if (!policy.enabled) return null;

  let strongest: RateLimitHold | null = null;
  for (const reading of readings) {
    const hold = holdForReading(reading, policy, nowMs);
    if (hold && (!strongest || hold.untilMs > strongest.untilMs)) strongest = hold;
  }
  return strongest;
}

/**
 * How long until a hold releases, in the coarsest unit that still reads
 * precisely — "in 4 minutes", "in about 3 hours", "in about 2 days". Pure so the
 * banner's countdown is unit-testable.
 */
export function formatTimeUntil(untilMs: number, nowMs: number): string {
  const minutes = Math.round((untilMs - nowMs) / 60_000);
  if (minutes <= 0) return 'any moment now';
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in about ${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.round(hours / 24);
  return `in about ${days} day${days === 1 ? '' : 's'}`;
}

/** Whether two holds are the same, for change detection before emitting events. */
export function holdsEqual(a: RateLimitHold | null, b: RateLimitHold | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.untilMs === b.untilMs && a.limitType === b.limitType && a.reason === b.reason;
}
