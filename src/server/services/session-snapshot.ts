import { prisma } from '@/lib/prisma';
import { toSessionView } from '@/lib/session-view';
import { HISTORY_PAGE_SIZE, type HistorySnapshot } from '@/lib/message-cache';
import { EMPTY_WATERMARK } from '@/lib/sse-resume';
import type { SessionLiveState, SessionStreamState } from '@/lib/session-stream-state';
import {
  getActivePartials,
  getPendingMessageIds,
  getSessionBackgroundTasks,
  getSessionRetry,
  isClaudeRunning,
} from './claude-runner';
import { queuedMessageIds } from './prompt-queue';
import { currentHold } from './rate-limit-pause';
import { getSessionCommands } from './session-commands';
import { getSessionUsageTotals } from './session-usage';
import { buildTokenUsageStats } from '@/lib/token-estimation';
import { taskHasEndState } from '@/lib/session-status';
import {
  hasMessagesThrough,
  loadEarliestTaskSpawnSequence,
  loadHistoryPage,
  loadMessagesAfter,
  type ParsedMessage,
} from './message-store';
import { refreshStalePullRequests } from './session-branch-pr';

/** What the per-session stream opens with (and re-sends on a buffer overflow). */
export interface SessionSnapshot extends SessionStreamState {
  history: HistorySnapshot<ParsedMessage>;
}

/**
 * Current value of every latest-value field the per-session stream carries. All
 * but `queuedMessageIds` and `tokenUsage` are in-memory only (lost on restart;
 * `rateLimitHold` is recomputed from persisted readings).
 */
async function loadLiveState(sessionId: string): Promise<SessionLiveState> {
  const [queued, usageTotals] = await Promise.all([
    queuedMessageIds(sessionId),
    getSessionUsageTotals(sessionId),
  ]);
  return {
    running: isClaudeRunning(sessionId),
    commands: getSessionCommands(sessionId),
    retry: getSessionRetry(sessionId),
    backgroundTasks: getSessionBackgroundTasks(sessionId),
    pendingMessageIds: getPendingMessageIds(sessionId),
    queuedMessageIds: queued,
    // The recompute's snapshot, the same source as the `rate_limit` channel and
    // the session list, so a snapshot can't contradict them.
    rateLimitHold: currentHold(sessionId),
    tokenUsage: buildTokenUsageStats(usageTotals),
  };
}

/**
 * The transcript part of a snapshot: the newest page, widened on a resumed
 * connection to everything after its watermark. The newest page is always
 * covered so that the range the client reconciles — where a cancelled prompt's
 * `message_removed` could have been missed — always includes it.
 *
 * Also widened back to the spawn of every still-running background task: its
 * box is pinned live at the bottom, but only once its spawning call is loaded,
 * and a long-running subagent can have been spawned pages ago.
 */
async function loadHistorySnapshot(
  sessionId: string,
  resumeAfter: number | null
): Promise<HistorySnapshot<ParsedMessage>> {
  const partials = getActivePartials(sessionId);
  const runningTaskIds = getSessionBackgroundTasks(sessionId)
    .filter(taskHasEndState)
    .map((task) => task.taskId);
  const [page, spawn] = await Promise.all([
    loadHistoryPage(sessionId, null, HISTORY_PAGE_SIZE),
    loadEarliestTaskSpawnSequence(sessionId, runningTaskIds),
  ]);
  const pageFloor = page.messages.length > 0 ? page.messages[0].sequence - 1 : EMPTY_WATERMARK;
  const after = Math.min(
    pageFloor,
    resumeAfter ?? pageFloor,
    spawn === null ? pageFloor : spawn - 1
  );
  if (after === pageFloor) {
    return { after, messages: page.messages, hasMore: page.hasMore, partials };
  }
  const [messages, hasMore] = await Promise.all([
    loadMessagesAfter(sessionId, after),
    hasMessagesThrough(sessionId, after),
  ]);
  return { after, messages, hasMore, partials };
}

/**
 * Everything a client needs to render a session, read after the caller has
 * subscribed to its events, so snapshot + deltas leave no gap. `resumeAfter` is a
 * reconnecting client's watermark (see {@link HistorySnapshot}). Null when the
 * session doesn't exist.
 */
export async function loadSessionSnapshot(
  sessionId: string,
  resumeAfter: number | null
): Promise<SessionSnapshot | null> {
  const [row, live, history] = await Promise.all([
    prisma.session.findUnique({ where: { id: sessionId } }),
    loadLiveState(sessionId),
    loadHistorySnapshot(sessionId, resumeAfter),
  ]);
  if (!row) return null;
  // Every (re)connect is a view of the session, which is what re-arms the PR poll.
  refreshStalePullRequests([row]);
  return { session: toSessionView(row), live, history };
}
