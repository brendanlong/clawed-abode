import { prisma } from '@/lib/prisma';
import { toSessionView } from '@/lib/session-view';
import { HISTORY_PAGE_SIZE, type HistorySnapshot } from '@/lib/message-cache';
import { EMPTY_WATERMARK } from '@/lib/sse-resume';
import type { SessionLiveState, SessionStreamState } from '@/lib/session-stream-state';
import {
  getPendingMessageIds,
  getSessionBackgroundTasks,
  getSessionRetry,
  isClaudeRunning,
} from './claude-runner';
import { queuedMessageIds } from './prompt-queue';
import { currentHold } from './rate-limit-pause';
import { getSessionCommands } from './session-commands';
import { loadHistoryPage, loadMessagesAfter, type ParsedMessage } from './message-store';
import { refreshStalePullRequests } from './session-branch-pr';

/** What the per-session stream opens with (and re-sends on a buffer overflow). */
export interface SessionSnapshot extends SessionStreamState {
  history: HistorySnapshot<ParsedMessage>;
}

/**
 * Current value of every latest-value field the per-session stream carries. All
 * but `queuedMessageIds` are in-memory only (lost on restart; `rateLimitHold` is
 * recomputed from persisted readings).
 */
async function loadLiveState(sessionId: string): Promise<SessionLiveState> {
  return {
    running: isClaudeRunning(sessionId),
    commands: getSessionCommands(sessionId),
    retry: getSessionRetry(sessionId),
    backgroundTasks: getSessionBackgroundTasks(sessionId),
    pendingMessageIds: getPendingMessageIds(sessionId),
    queuedMessageIds: await queuedMessageIds(sessionId),
    // The recompute's snapshot, the same source as the `rate_limit` channel and
    // the session list, so a snapshot can't contradict them.
    rateLimitHold: currentHold(sessionId),
  };
}

/**
 * The transcript part of a snapshot. Fresh connections get the newest page. A
 * resumed one gets everything after its watermark, widened to at least the newest
 * page so that the range the client must reconcile — where a cancelled prompt's
 * `message_removed` could have been missed — is always covered.
 */
async function loadHistorySnapshot(
  sessionId: string,
  resumeAfter: number | null
): Promise<HistorySnapshot<ParsedMessage>> {
  const page = await loadHistoryPage(sessionId, null, HISTORY_PAGE_SIZE);
  if (resumeAfter === null) return { kind: 'page', ...page };
  const pageFloor = page.messages.length > 0 ? page.messages[0].sequence - 1 : EMPTY_WATERMARK;
  if (pageFloor <= resumeAfter) return { kind: 'since', after: pageFloor, messages: page.messages };
  return {
    kind: 'since',
    after: resumeAfter,
    messages: await loadMessagesAfter(sessionId, resumeAfter),
  };
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
