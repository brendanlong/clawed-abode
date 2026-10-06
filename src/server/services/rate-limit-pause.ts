/**
 * The reaction to a subscription rate-limit hold: pause the held sessions (recall
 * what the CLI hasn't read into the durable queue, interrupt the live turn) and
 * drain the released ones. The readings and policy that decide a hold live in
 * rate-limit-state; the session queries live in claude-runner, reached only
 * through the {@link PauseRunner} port handed to {@link initRateLimitPause}.
 * Rationale: doc/rate-limit-pause.md.
 */

import { prisma } from '@/lib/prisma';
import { coalesce } from '@/lib/coalesce';
import type { CancelledPrompt } from '@/lib/cancelled-prompt';
import { createLogger, toError } from '@/lib/logger';
import { diffHolds, type RateLimitHold } from '@/lib/rate-limit';
import { sseEvents } from './events';
import { discardUnreadPrompts } from './in-flight-commands';
import {
  claimQueuedPrompt,
  clearQueuedPrompts,
  emitQueuedPrompts,
  enqueuePrompts,
  listQueuedPrompts,
  type PromptPayload,
} from './prompt-queue';
import {
  loadRateLimitReadings,
  resolveAllSessionHolds,
  setRateLimitChangeHandler,
} from './rate-limit-state';

const log = createLogger('rate-limit-pause');

/** What the pause needs from the runner that owns the session queries. */
export interface PauseRunner {
  /**
   * Sessions whose main turn the stream has actually opened — not one a push set
   * optimistically (nothing started, so there is nothing to continue). Synchronous.
   */
  turnActiveSessionIds(): Set<string>;
  /**
   * Recall everything the CLI hasn't read and hand it to `dispose`, then interrupt
   * a genuinely running turn (not one already being interrupted), running
   * `beforeInterrupt` just before. Null when the session has no live query.
   * `interruptPending` is whether an interrupt (this one or an earlier one) is
   * still on its way down.
   */
  abortTurn<T>(
    sessionId: string,
    steps: {
      dispose: (recalled: PromptPayload[]) => Promise<T>;
      beforeInterrupt: () => Promise<void>;
    }
  ): Promise<{ disposed: T; interrupted: boolean; interruptPending: boolean } | null>;
  sendUserMessage(
    sessionId: string,
    prompt: string,
    opts: { userInitiated: boolean }
  ): Promise<void>;
  /**
   * Establish (or reuse) the session's query. The handle is bound to that query:
   * `isLive` turns false once it is gone, and `push` must then not be called.
   */
  openQuery(sessionId: string): Promise<{ isLive(): boolean; push(prompt: PromptPayload): void }>;
}

let runner: PauseRunner | null = null;

/**
 * Prompt sent to a session whose turn a rate-limit pause cut short, once the
 * window resets. Phrased so an agent that had already finished can say so
 * cheaply rather than redoing work.
 */
export const RATE_LIMIT_RESUME_PROMPT =
  'The subscription usage window has reset. Continue the work you were doing when the ' +
  'usage limit paused you. If you had already finished, just say so briefly.';

/**
 * The hold each session is under, as of the last recompute — the one source for
 * everything that shows or acts on a hold, so the session list, the live state and
 * the SSE channel can never disagree.
 */
const currentHolds = new Map<string, RateLimitHold>();

/** This session's hold as of the last recompute, or null. */
export function currentHold(sessionId: string): RateLimitHold | null {
  return currentHolds.get(sessionId) ?? null;
}

/** Whether a session is currently paused for a rate limit (see {@link currentHold}). */
export function isSessionRateLimitPaused(sessionId: string): boolean {
  return currentHolds.has(sessionId);
}

/**
 * Re-evaluate every session's rate-limit hold and act on it: pause the newly held
 * and drain the newly released. Idempotent — it computes the desired state and
 * converges on it rather than tracking edges, so a missed or duplicated trigger is
 * harmless. Serialized: readings arrive from several sessions at once, and two
 * concurrent recomputes would race to push the same queued prompt twice. Awaiting
 * it means a recompute that started after the call has finished.
 */
export const recomputeRateLimitHolds = coalesce(() =>
  // The trigger is a fire-and-forget callback from rate-limit-state, so nothing
  // is left to catch a rejection: swallow it here rather than crash the process.
  runRecompute().catch((err: unknown) => log.error('Rate-limit recompute failed', toError(err)))
);

async function runRecompute(): Promise<void> {
  if (!runner) {
    log.warn('Rate-limit recompute before initRateLimitPause; skipping');
    return;
  }
  // Snapshot which sessions are genuinely mid-turn BEFORE any await: a rejection
  // kills the turn it lands in, and by the time the holds are resolved that turn
  // may already have collapsed — losing the very fact that tells us to nudge it
  // later. A merely optimistic turnActive doesn't count: nothing started, so
  // there is nothing to continue, and the prompt is recalled into the queue where
  // it will run again in full.
  const turnActiveSessionIds = runner.turnActiveSessionIds();

  let holds: Map<string, RateLimitHold>;
  try {
    holds = await resolveAllSessionHolds();
  } catch (err) {
    log.error('Failed to resolve rate-limit holds', toError(err));
    return;
  }

  for (const { sessionId, hold } of diffHolds(currentHolds, holds)) {
    if (hold) currentHolds.set(sessionId, hold);
    else currentHolds.delete(sessionId);
    sseEvents.emitRateLimitHold(sessionId, hold);
  }

  for (const [sessionId, hold] of holds) {
    try {
      await pauseSession(runner, sessionId, hold, turnActiveSessionIds.has(sessionId));
    } catch (err) {
      // One session failing to park must not skip the drain phase for the rest.
      log.error('Failed to pause session for rate limit', toError(err), { sessionId });
    }
  }

  let toDrain: { id: string }[];
  try {
    toDrain = await prisma.session.findMany({
      where: {
        status: 'running',
        OR: [{ resumeAfterRateLimit: true }, { queuedPrompts: { some: {} } }],
      },
      select: { id: true },
    });
  } catch (err) {
    log.error('Failed to list sessions with queued work', toError(err));
    return;
  }

  for (const { id } of toDrain) {
    if (holds.has(id)) continue;
    await drainSession(runner, id);
  }
}

/**
 * Hold a session's work: pull back everything the CLI has queued but not read into
 * the durable queue, then interrupt the live turn so it stops spending — a long
 * turn (subagents especially) can otherwise run on for hours past the limit.
 */
async function pauseSession(
  runner: PauseRunner,
  sessionId: string,
  hold: RateLimitHold,
  hadActiveTurn: boolean
): Promise<void> {
  const aborted = await runner.abortTurn(sessionId, {
    // Durable before the interrupt, so a Stop landing during it can take them back.
    dispose: async (recalled) => {
      if (recalled.length === 0) return 0;
      await enqueuePrompts(sessionId, recalled);
      await emitQueuedPrompts(sessionId);
      return recalled.length;
    },
    // Flag before interrupting, not after: a Stop landing while the interrupt is
    // in flight withdraws the nudge, and must not have it set back.
    beforeInterrupt: () => flagForResume(sessionId),
  });
  const interrupted = aborted?.interrupted ?? false;
  if (aborted && (aborted.disposed > 0 || interrupted)) {
    log.info('Paused session for rate limit', {
      sessionId,
      limitType: hold.limitType,
      reason: hold.reason,
      requeued: aborted.disposed,
      interrupted,
      resumesAt: new Date(hold.untilMs).toISOString(),
    });
  }

  // A rejection may already have killed the turn before we got here, so it goes
  // by the pre-await snapshot (unless an interrupt is already underway — whoever
  // asked owns the resume flag); otherwise only a turn we actually cut short needs
  // a nudge once the window resets.
  const rejectedMidTurn =
    hold.reason === 'rejected' && hadActiveTurn && !(aborted?.interruptPending ?? false);
  if (!interrupted && rejectedMidTurn) await flagForResume(sessionId);
}

/**
 * Mark a session to be nudged to continue once the window resets. Best-effort.
 * Set even when the interrupt then fails: the nudge is phrased so an agent that
 * had finished just says so. Only while the session is running, in the same
 * statement: the header Stop clears the flag as it stops, and a pause write
 * landing after it must not re-arm the nudge for the next Start.
 */
async function flagForResume(sessionId: string): Promise<void> {
  try {
    await prisma.session.updateMany({
      where: { id: sessionId, status: 'running' },
      data: { resumeAfterRateLimit: true },
    });
  } catch (err) {
    log.warn('Failed to flag session for post-rate-limit resume', {
      sessionId,
      error: toError(err).message,
    });
  }
}

/**
 * Release a session: nudge it to continue a turn the limit cut short, then re-push
 * its queued prompts in order. Each push re-checks the query, so one that dies
 * mid-drain simply leaves the rest queued for the next attempt rather than
 * dropping it.
 */
async function drainSession(runner: PauseRunner, sessionId: string): Promise<void> {
  try {
    const { count } = await prisma.session.updateMany({
      where: { id: sessionId, status: 'running', resumeAfterRateLimit: true },
      data: { resumeAfterRateLimit: false },
    });
    if (count > 0) {
      log.info('Resuming turn cut short by a rate limit', { sessionId });
      // Not user-initiated: a window resetting is a lifecycle event, and bumping
      // lastActivityAt would reshuffle the session list with no user involved
      // (see doc/DESIGN.md on Session.lastActivityAt).
      await runner.sendUserMessage(sessionId, RATE_LIMIT_RESUME_PROMPT, { userInitiated: false });
    }

    const queued = await listQueuedPrompts(sessionId);
    if (queued.length === 0) return;

    log.info('Releasing prompts queued behind a rate-limit pause', {
      sessionId,
      count: queued.length,
    });
    const query = await runner.openQuery(sessionId);
    for (const prompt of queued) {
      // The query can vanish mid-drain (CLI crash, stop); leave the rest queued.
      if (!query.isLive()) break;
      // Claim before pushing: Stop can empty the queue underneath this loop, and
      // pushing a prompt it already took back would run cancelled work with no
      // bubble to show for it.
      if (!(await claimQueuedPrompt(prompt.id))) continue;
      query.push(prompt);
    }
  } catch (err) {
    // Leaving the queue in place is the safe failure: the next recompute retries.
    log.error('Failed to drain rate-limit queue', toError(err), { sessionId });
  } finally {
    await emitQueuedPrompts(sessionId).catch(() => {});
  }
}

/**
 * Empty a session's rate-limit queue for Stop: the prompts never ran, so their
 * bubbles go too and the text comes back for the composer. Also cancels a pending
 * "continue where you left off" nudge — the user stopping is a clear signal they
 * don't want the session picking work back up on its own.
 */
export async function withdrawQueuedWork(sessionId: string): Promise<CancelledPrompt[]> {
  const queued = await clearQueuedPrompts(sessionId);
  await prisma.session.updateMany({
    where: { id: sessionId, resumeAfterRateLimit: true },
    data: { resumeAfterRateLimit: false },
  });
  if (queued.length === 0) return [];

  const cancelled = await discardUnreadPrompts(sessionId, queued);
  await emitQueuedPrompts(sessionId);
  return cancelled;
}

/**
 * Wire up the rate-limit pause and restore its state, then kick a first recompute.
 *
 * Restoring the readings is awaited so nothing can release queued work before we
 * know whether the window is still exhausted. The recompute is deliberately NOT
 * awaited: if the window reset while the server was down it drains, which means
 * establishing queries — and a slow one must not stall startup. That drain is the
 * one place a session revives without a user interaction (doc/DESIGN.md's lazy
 * revival); the user's queued prompt is exactly the interaction, just an earlier one.
 */
export async function initRateLimitPause(pauseRunner: PauseRunner): Promise<void> {
  runner = pauseRunner;
  setRateLimitChangeHandler(() => void recomputeRateLimitHolds());
  await loadRateLimitReadings();
  void recomputeRateLimitHolds();
}
