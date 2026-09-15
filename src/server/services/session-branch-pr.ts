import { prisma } from '@/lib/prisma';
import { createLogger, toError } from '@/lib/logger';
import { extractRepoFullName } from '@/lib/utils';
import {
  isPrSnapshotStale,
  parsePullRequestJson,
  serializePullRequest,
  type PrRefreshCandidate,
} from '@/lib/pull-request';
import { sseEvents } from './events';
import { fetchPullRequestForBranch } from './github';
import { getCurrentBranch } from './worktree-manager';

const log = createLogger('session-branch-pr');

/** The row a caller hands us; `pullRequest` is still the raw JSON column. */
type SessionRow = Omit<PrRefreshCandidate, 'pullRequest'> & { pullRequest: string | null };

const prSnapshotSelect = {
  id: true,
  status: true,
  repoUrl: true,
  currentBranch: true,
  pullRequest: true,
  prCheckedAt: true,
} as const;

/**
 * Ask GitHub about `branch` and persist the answer on the session. `prCheckedAt`
 * is always written (that's what the TTL reads); the SSE update only fires when a
 * client-visible field actually changed, so a poll that finds nothing new doesn't
 * make every open list re-render.
 *
 * The write is conditional on `currentBranch` still being what `session` said,
 * so a turn that switches branches mid-fetch wins and we never pin one branch's
 * PR onto another's row.
 */
async function persistPrSnapshot(
  session: SessionRow,
  branch: string | null,
  branchUpdate?: { currentBranch: string }
): Promise<void> {
  // A snapshot belongs to one branch: never carry it over to a new one.
  let pullRequest = branchUpdate ? null : session.pullRequest;
  if (session.repoUrl && branch) {
    const pr = await fetchPullRequestForBranch(extractRepoFullName(session.repoUrl), branch);
    // undefined = lookup unavailable (no token / API error): keep what we had.
    if (pr !== undefined) pullRequest = serializePullRequest(pr);
  }

  const visibleChanges = {
    ...branchUpdate,
    ...(pullRequest !== session.pullRequest ? { pullRequest } : {}),
  };
  const [updated] = await prisma.session.updateManyAndReturn({
    where: { id: session.id, currentBranch: session.currentBranch },
    data: { ...visibleChanges, prCheckedAt: new Date() },
  });
  if (updated && Object.keys(visibleChanges).length > 0) {
    sseEvents.emitSessionUpdate(session.id, updated);
  }
}

/**
 * Detect a branch change and refresh the persisted PR status for the session
 * (fire-and-forget, called at each turn end). PR status lives on the Session row
 * so the list never has to ask GitHub per row; one `session` event carries both
 * fields.
 */
export async function detectBranchAndPr(sessionId: string, workingDir: string): Promise<void> {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: prSnapshotSelect,
    });
    if (!session) return;

    const detectedBranch = await getCurrentBranch(workingDir);
    const branchChanged = detectedBranch !== null && detectedBranch !== session.currentBranch;

    await persistPrSnapshot(
      session,
      detectedBranch ?? session.currentBranch,
      branchChanged ? { currentBranch: detectedBranch } : undefined
    );
  } catch (err) {
    log.debug('Failed to detect branch or check PR', { sessionId, error: toError(err).message });
  }
}

/**
 * Sessions queued or being refreshed, so concurrent readers make one call, not N.
 * The cap keeps a single list read — which can carry every loaded page — from
 * opening a burst of connections GitHub would answer with a secondary rate limit.
 */
const refreshesPending = new Set<string>();
const refreshQueue: string[] = [];
let refreshesActive = 0;
const MAX_CONCURRENT_REFRESHES = 4;

function pumpRefreshQueue(): void {
  while (refreshesActive < MAX_CONCURRENT_REFRESHES && refreshQueue.length > 0) {
    const sessionId = refreshQueue.shift()!;
    refreshesActive++;
    void refreshSessionPr(sessionId)
      .catch((err) => {
        log.debug('Failed to refresh PR', { sessionId, error: toError(err).message });
      })
      .finally(() => {
        refreshesActive--;
        refreshesPending.delete(sessionId);
        pumpRefreshQueue();
      });
  }
}

async function refreshSessionPr(sessionId: string): Promise<void> {
  // Re-read rather than trusting the caller's row: a turn end may have landed
  // since it was selected, and this runs off the request that queued it.
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: prSnapshotSelect,
  });
  if (!session) return;

  await persistPrSnapshot(session, session.currentBranch);
}

/**
 * Re-fetch the PR for every session in a page the client just read whose snapshot
 * has aged out (see {@link isPrSnapshotStale}). Queued rather than awaited: the
 * response doesn't wait on GitHub, and the fresh row arrives over SSE.
 */
export function refreshStalePullRequests(sessions: SessionRow[]): void {
  const now = Date.now();
  for (const session of sessions) {
    const candidate = { ...session, pullRequest: parsePullRequestJson(session.pullRequest) };
    if (!isPrSnapshotStale(candidate, now)) continue;
    if (refreshesPending.has(session.id)) continue;

    refreshesPending.add(session.id);
    refreshQueue.push(session.id);
  }
  pumpRefreshQueue();
}
