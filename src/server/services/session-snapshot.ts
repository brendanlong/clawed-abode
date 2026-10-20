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
import {
  hasMessagesThrough,
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
 * The transcript part of a snapshot: the newest page, widened on a resumed
 * connection to everything after its watermark. The newest page is always
 * covered so that the range the client reconciles — where a cancelled prompt's
 * `message_removed` could have been missed — always includes it.
 */
async function loadHistorySnapshot(
  sessionId: string,
  resumeAfter: number | null
): Promise<HistorySnapshot<ParsedMessage>> {
  const partials = getActivePartials(sessionId);
  const page = await loadHistoryPage(sessionId, null, HISTORY_PAGE_SIZE);
  const pageFloor = page.messages.length > 0 ? page.messages[0].sequence - 1 : EMPTY_WATERMARK;
  if (resumeAfter === null || pageFloor <= resumeAfter) {
    return { after: pageFloor, messages: page.messages, hasMore: page.hasMore, partials };
  }
  const [messages, hasMore] = await Promise.all([
    loadMessagesAfter(sessionId, resumeAfter),
    hasMessagesThrough(sessionId, resumeAfter),
  ]);
  return { after: resumeAfter, messages, hasMore, partials };
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
