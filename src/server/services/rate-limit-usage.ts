/**
 * Pre-emptive half of the rate-limit pause: ask a live query for the structured
 * `/usage` snapshot at turn boundaries and feed its utilization figures into
 * rate-limit-state.
 *
 * Why poll at all when `rate_limit_event` exists: that event fires only when the
 * subscription's rate-limit *info changes*, and in practice that means status
 * transitions — it can't be relied on to deliver a utilization figure while a
 * window is merely filling. The threshold pause needs a number, so it comes from
 * here. The reactive `rejected` signal still comes from the event.
 *
 * A turn boundary is the right moment: pausing there costs no in-progress work.
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { createLogger, toError } from '@/lib/logger';
import { parseUsageSnapshot } from '@/lib/rate-limit';
import { recordRateLimitReadings } from './rate-limit-state';

const log = createLogger('rate-limit-usage');

/**
 * Shortest gap between snapshots, across all sessions. The call reaches the
 * claude.ai usage endpoint, so a machine running ten sessions must not ask ten
 * times per turn; utilization moves slowly enough that a minute of staleness
 * costs at most a fraction of a window.
 */
export const USAGE_POLL_INTERVAL_MS = 60_000;

let lastPollMs = 0;
let polling = false;

/**
 * The method is experimental and named accordingly, so it is feature-detected
 * rather than typed — an SDK without it simply leaves the threshold pause to
 * whatever utilization the rate-limit events happen to carry.
 */
interface UsageCapableQuery {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<unknown>;
}

function asUsageCapable(query: Query): UsageCapableQuery | null {
  const candidate = query as Partial<UsageCapableQuery>;
  return typeof candidate.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === 'function'
    ? (candidate as UsageCapableQuery)
    : null;
}

/**
 * Read plan utilization through this query and record it, unless a snapshot was
 * taken recently. Best-effort and never throws: failing to read usage only costs
 * the pre-emptive pause, and the `rejected` backstop still applies.
 */
export async function pollRateLimitUsage(query: Query, nowMs = Date.now()): Promise<void> {
  if (polling || nowMs - lastPollMs < USAGE_POLL_INTERVAL_MS) return;
  const usable = asUsageCapable(query);
  if (!usable) return;

  polling = true;
  lastPollMs = nowMs;
  try {
    const snapshot = await usable.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    await recordRateLimitReadings(parseUsageSnapshot(snapshot, Date.now()));
  } catch (err) {
    log.debug('Failed to read plan usage', { error: toError(err).message });
  } finally {
    polling = false;
  }
}

/** Test seam: forget when the last snapshot was taken. */
export function _resetUsagePolling(): void {
  lastPollMs = 0;
  polling = false;
}
