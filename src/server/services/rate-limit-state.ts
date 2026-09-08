/**
 * Account-wide subscription rate-limit readings, and the per-session policy that
 * turns them into a pause. Owns the persisted window state and the timer that
 * fires when a window resets; the *reaction* to a hold (pausing a query, draining
 * a queue) belongs to claude-runner, which subscribes here.
 *
 * Readings are shared because there is one subscription; policy is per-session so
 * a low-priority session can pause at 50% of the 5-hour window while an urgent one
 * runs on into overage credits. Rationale: doc/rate-limit-pause.md.
 */

import { prisma } from '@/lib/prisma';
import { createLogger, toError } from '@/lib/logger';
import {
  activeReadings,
  clampThreshold,
  decideHold,
  DEFAULT_PAUSE_THRESHOLD,
  mergeReading,
  nextReadingExpiry,
  resolvePausePolicy,
  type HoldableLimitType,
  type PausePolicy,
  type RateLimitHold,
  type RateLimitReading,
} from '@/lib/rate-limit';
import { GLOBAL_SETTINGS_ID } from './settings-scope';

const log = createLogger('rate-limit-state');

/** Latest reading per window, account-wide. Rehydrated from the DB at startup. */
let readings: RateLimitReading[] = [];
let expiryTimer: NodeJS.Timeout | null = null;
let onChange: (() => void) | null = null;

/**
 * Register the reaction to a change in holds (a new reading, or a window
 * resetting). Called once by claude-runner at startup; a second call replaces the
 * first so a hot reload can't stack listeners.
 */
export function setRateLimitChangeHandler(handler: (() => void) | null): void {
  onChange = handler;
}

/** Currently-meaningful readings (windows that haven't rolled over yet). */
export function getRateLimitReadings(): RateLimitReading[] {
  return activeReadings(readings, Date.now());
}

/**
 * Wake when the earliest active window resets, so a hold releases on time rather
 * than on the next incidental event. Rescheduled from scratch on every change —
 * there is at most one pending wake.
 */
function scheduleExpiryWake(): void {
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  const now = Date.now();
  const next = nextReadingExpiry(readings, now);
  if (next === null) return;

  // A reset can be a week out; setTimeout tops out around 24.8 days, so a weekly
  // window still fits comfortably. +1s so the reading is unambiguously expired
  // when the handler reads the clock.
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null;
      readings = activeReadings(readings, Date.now());
      void sweepExpiredWindows();
      scheduleExpiryWake();
      onChange?.();
    },
    next - now + 1000
  );
  expiryTimer.unref?.();
}

async function sweepExpiredWindows(): Promise<void> {
  try {
    await prisma.rateLimitWindow.deleteMany({ where: { resetsAt: { lte: new Date() } } });
  } catch (err) {
    log.debug('Failed to sweep expired rate-limit windows', { error: toError(err).message });
  }
}

/**
 * Fold newly-observed readings into the known set, persist them, and notify if
 * anything changed. Persistence matters across a restart: without it the server
 * would come back believing nothing is limited and release every paused session
 * into a window that is still exhausted.
 */
export async function recordRateLimitReadings(incoming: RateLimitReading[]): Promise<void> {
  if (incoming.length === 0) return;
  const now = Date.now();

  const before = readings;
  for (const reading of incoming) {
    readings = mergeReading(readings, reading, now);
  }
  if (!readingsChanged(before, readings)) return;

  for (const reading of readings) {
    log.info('Observed subscription rate limit', {
      limitType: reading.limitType,
      rejected: reading.rejected,
      utilization: reading.utilization,
      resetsAt: new Date(reading.resetsAtMs).toISOString(),
    });
  }

  await persistReadings(mergedFor(new Set(incoming.map((r) => r.limitType))));
  scheduleExpiryWake();
  onChange?.();
}

function readingsChanged(before: RateLimitReading[], after: RateLimitReading[]): boolean {
  if (before.length !== after.length) return true;
  return before.some((b, i) => {
    const a = after[i];
    return (
      b.limitType !== a.limitType ||
      b.rejected !== a.rejected ||
      b.utilization !== a.utilization ||
      b.resetsAtMs !== a.resetsAtMs
    );
  });
}

/** Persist the merged state of the windows the incoming readings touched. */
function mergedFor(limitTypes: Set<string>): RateLimitReading[] {
  return readings.filter((r) => limitTypes.has(r.limitType));
}

async function persistReadings(incoming: RateLimitReading[]): Promise<void> {
  try {
    await Promise.all(
      incoming.map((reading) => {
        const data = {
          rejected: reading.rejected,
          utilization: reading.utilization,
          resetsAt: new Date(reading.resetsAtMs),
          observedAt: new Date(),
        };
        return prisma.rateLimitWindow.upsert({
          where: { limitType: reading.limitType },
          create: { limitType: reading.limitType, ...data },
          update: data,
        });
      })
    );
  } catch (err) {
    // Losing a reading only costs us the pause across a restart, never correctness.
    log.warn('Failed to persist rate-limit readings', { error: toError(err).message });
  }
}

/** Rehydrate readings from the DB and arm the reset timer. Runs once at startup. */
export async function loadRateLimitReadings(): Promise<void> {
  const now = new Date();
  try {
    const rows = await prisma.rateLimitWindow.findMany({ where: { resetsAt: { gt: now } } });
    readings = rows
      .map((row) => ({
        limitType: row.limitType as HoldableLimitType,
        rejected: row.rejected,
        // What was persisted is the merged state, so it stands on its own.
        authoritative: true,
        utilization: row.utilization,
        resetsAtMs: row.resetsAt.getTime(),
      }))
      .sort((a, b) => a.limitType.localeCompare(b.limitType));
  } catch (err) {
    log.error('Failed to load rate-limit windows', toError(err));
    readings = [];
  }
  if (readings.length > 0) {
    log.info('Restored subscription rate-limit state', {
      windows: readings.map((r) => r.limitType),
    });
  }
  await sweepExpiredWindows();
  scheduleExpiryWake();
}

/** The global default policy sessions inherit when they set no override. */
export async function loadGlobalPausePolicy(): Promise<PausePolicy> {
  const settings = await prisma.globalSettings.findUnique({
    where: { id: GLOBAL_SETTINGS_ID },
    select: { rateLimitPauseEnabled: true, rateLimitPauseThreshold: true },
  });
  return {
    enabled: settings?.rateLimitPauseEnabled ?? false,
    threshold: clampThreshold(settings?.rateLimitPauseThreshold ?? DEFAULT_PAUSE_THRESHOLD),
  };
}

const SESSION_POLICY_SELECT = {
  id: true,
  rateLimitPauseEnabled: true,
  rateLimitPauseThreshold: true,
} as const;

type SessionPolicyRow = {
  id: string;
  rateLimitPauseEnabled: boolean | null;
  rateLimitPauseThreshold: number | null;
};

function holdForRow(row: SessionPolicyRow, global: PausePolicy, nowMs: number) {
  const policy = resolvePausePolicy(
    { enabled: row.rateLimitPauseEnabled, threshold: row.rateLimitPauseThreshold },
    global
  );
  return decideHold(readings, policy, nowMs);
}

/**
 * The hold in effect for one session right now, or `null` if it may work. Used on
 * the send path, so it reads the session's policy fresh rather than trusting a
 * snapshot taken at the last recompute.
 */
export async function resolveSessionHold(sessionId: string): Promise<RateLimitHold | null> {
  const now = Date.now();
  if (activeReadings(readings, now).length === 0) return null;

  const [row, global] = await Promise.all([
    prisma.session.findUnique({ where: { id: sessionId }, select: SESSION_POLICY_SELECT }),
    loadGlobalPausePolicy(),
  ]);
  if (!row) return null;
  return holdForRow(row, global, now);
}

/**
 * Holds for every session that isn't archived, keyed by session id (absent means
 * "not held"). Two queries regardless of session count — the recompute runs on
 * every reading change, so it must not fan out per session.
 */
export async function resolveAllSessionHolds(): Promise<Map<string, RateLimitHold>> {
  const now = Date.now();
  const [rows, global] = await Promise.all([
    prisma.session.findMany({
      where: { status: { not: 'archived' } },
      select: SESSION_POLICY_SELECT,
    }),
    loadGlobalPausePolicy(),
  ]);

  const holds = new Map<string, RateLimitHold>();
  for (const row of rows) {
    const hold = holdForRow(row, global, now);
    if (hold) holds.set(row.id, hold);
  }
  return holds;
}

/** Test seam: drop all in-memory state and cancel the pending reset wake. */
export function _resetRateLimitState(): void {
  readings = [];
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  onChange = null;
}
