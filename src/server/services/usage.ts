/**
 * The agents' view of subscription usage: the check_usage report, refreshed from
 * the SDK's experimental `/usage` call when the readings are old, and the opt-in
 * alerts set with set_usage_alerts. Readings are the rate-limit pause's
 * (rate-limit-state); the session queries are reached only through the
 * {@link UsagePort} handed to {@link initUsage}. Rationale:
 * doc/rate-limit-pause.md "Usage Tools".
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { prisma } from '@/lib/prisma';
import { coalesce } from '@/lib/coalesce';
import { processSingleton } from '@/lib/process-singleton';
import { createLogger, toError } from '@/lib/logger';
import type { HoldableLimitType } from '@/lib/rate-limit';
import {
  buildUsageReport,
  dueUsageAlerts,
  formatUsageAlert,
  markUsageAlertsSent,
  parseUsageSnapshot,
  type UsageAlertThresholds,
  type UsageSnapshot,
} from '@/lib/usage';
import {
  getRateLimitObservedAt,
  getRateLimitReadings,
  onRateLimitChange,
  recordRateLimitReadings,
} from './rate-limit-state';

const log = createLogger('usage');

export interface UsagePort {
  /** The agent is mid-turn or has a background task that will finish. */
  isSessionWorking(sessionId: string): boolean;
  /** Send a message on the app's behalf, only to a session whose query is live. */
  deliverMessage(sessionId: string, text: string): Promise<void>;
  /** A live query on the subscription (not a proxied model), preferring this session's. */
  subscriptionQuery(preferSessionId: string): Query | null;
}

/** Older readings are refreshed before a report; also the most often a refresh is tried. */
const STALE_MS = 5 * 60 * 1000;
const SNAPSHOT_TIMEOUT_MS = 15_000;

const state = processSingleton<{
  port: UsagePort | null;
  /** Per session, which windows it has already been alerted about. */
  sentAlerts: Map<string, ReadonlyMap<HoldableLimitType, number>>;
  extras: (Omit<UsageSnapshot, 'readings'> & { fetchedAtMs: number }) | null;
  lastRefreshAttemptMs: number;
}>('usage', () => ({ port: null, sentAlerts: new Map(), extras: null, lastRefreshAttemptMs: 0 }));

export function initUsage(port: UsagePort): void {
  state.port = port;
  onRateLimitChange('usage', () => void checkAllUsageAlerts());
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Ask a CLI for its `/usage` snapshot. The SDK call is explicitly experimental,
 * so any failure (a throw, a hang, a changed shape, or no plan limits for this
 * credential) just leaves the readings as they were.
 */
async function fetchUsageSnapshot(query: Query): Promise<UsageSnapshot | null> {
  try {
    const raw = await withTimeout(
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      SNAPSHOT_TIMEOUT_MS
    );
    return parseUsageSnapshot(raw, Date.now());
  } catch (err) {
    log.warn('Usage snapshot failed', { error: toError(err).message });
    return null;
  }
}

async function refreshUsage(preferSessionId: string): Promise<void> {
  const query = state.port?.subscriptionQuery(preferSessionId);
  if (!query) return;
  const snapshot = await fetchUsageSnapshot(query);
  if (!snapshot) return;
  state.extras = {
    modelWindows: snapshot.modelWindows,
    extraUsage: snapshot.extraUsage,
    fetchedAtMs: Date.now(),
  };
  await recordRateLimitReadings(snapshot.readings);
}

async function loadThresholds(sessionId: string): Promise<UsageAlertThresholds> {
  const row = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { usageAlertFiveHour: true, usageAlertWeekly: true },
  });
  return { fiveHour: row?.usageAlertFiveHour ?? null, weekly: row?.usageAlertWeekly ?? null };
}

/** The check_usage report, refreshed first when the readings are old. */
export async function getUsageReport(sessionId: string) {
  const now = Date.now();
  const observedAt = getRateLimitObservedAt();
  if (
    (observedAt === null || now - observedAt > STALE_MS) &&
    now - state.lastRefreshAttemptMs > STALE_MS
  ) {
    // Set before the await, so concurrent reports don't each fetch.
    state.lastRefreshAttemptMs = now;
    await refreshUsage(sessionId);
  }
  return buildUsageReport({
    readings: getRateLimitReadings(),
    observedAtMs: getRateLimitObservedAt(),
    extras: state.extras,
    thresholds: await loadThresholds(sessionId),
    nowMs: Date.now(),
  });
}

/**
 * Set a session's alert thresholds. Windows already past a new threshold count as
 * alerted, since the tool's reply already tells the agent where usage stands.
 */
export async function setUsageAlerts(
  sessionId: string,
  thresholds: UsageAlertThresholds
): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { usageAlertFiveHour: thresholds.fiveHour, usageAlertWeekly: thresholds.weekly },
  });
  const due = dueUsageAlerts(getRateLimitReadings(), thresholds, new Map());
  state.sentAlerts.set(sessionId, markUsageAlertsSent(new Map(), due));
}

/**
 * Tell a working session about any alerts that came due. Idle sessions are left
 * alone rather than woken: they hear at their next turn (the runner calls
 * {@link checkUsageAlerts} when a session starts working), and only about windows
 * still current then, since a reading drops out when its window resets.
 */
async function deliverDueAlerts(sessionId: string, thresholds: UsageAlertThresholds) {
  const { port } = state;
  if (!port?.isSessionWorking(sessionId)) return;
  const sent = state.sentAlerts.get(sessionId) ?? new Map<HoldableLimitType, number>();
  const due = dueUsageAlerts(getRateLimitReadings(), thresholds, sent);
  if (due.length === 0) return;
  // Marked before the await, in the same synchronous step as the check, so a
  // concurrent check can't deliver the same alert twice.
  state.sentAlerts.set(sessionId, markUsageAlertsSent(sent, due));
  log.info('Delivering usage alert', { sessionId, windows: due.map((r) => r.limitType) });
  await port.deliverMessage(sessionId, formatUsageAlert(due, Date.now()));
}

/** Check one session's alerts; called by the runner when the session starts working. */
export async function checkUsageAlerts(sessionId: string): Promise<void> {
  try {
    const thresholds = await loadThresholds(sessionId);
    if (thresholds.fiveHour === null && thresholds.weekly === null) return;
    await deliverDueAlerts(sessionId, thresholds);
  } catch (err) {
    log.warn('Usage alert check failed', { sessionId, error: toError(err).message });
  }
}

/** Check every opted-in session's alerts; runs on each change in the readings. */
const checkAllUsageAlerts = processSingleton('usage.checkAll', () =>
  coalesce(async () => {
    try {
      const rows = await prisma.session.findMany({
        where: {
          status: 'running',
          OR: [{ usageAlertFiveHour: { not: null } }, { usageAlertWeekly: { not: null } }],
        },
        select: { id: true, usageAlertFiveHour: true, usageAlertWeekly: true },
      });
      await Promise.all(
        rows.map((row) =>
          deliverDueAlerts(row.id, {
            fiveHour: row.usageAlertFiveHour,
            weekly: row.usageAlertWeekly,
          }).catch((err: unknown) =>
            log.warn('Usage alert delivery failed', {
              sessionId: row.id,
              error: toError(err).message,
            })
          )
        )
      );
    } catch (err) {
      log.warn('Usage alert check failed', { error: toError(err).message });
    }
  })
);

/** Test seam. */
export function _resetUsageState(): void {
  state.port = null;
  state.sentAlerts.clear();
  state.extras = null;
  state.lastRefreshAttemptMs = 0;
}
