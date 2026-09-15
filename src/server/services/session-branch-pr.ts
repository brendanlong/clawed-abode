import { prisma } from '@/lib/prisma';
import { createLogger, toError } from '@/lib/logger';
import { extractRepoFullName } from '@/lib/utils';
import {
  isPrSnapshotStale,
  serializePullRequest,
  type PrRefreshCandidate,
} from '@/lib/pull-request';
import { sseEvents } from './events';
import { fetchPullRequestForBranch } from './github';
import { getCurrentBranch } from './worktree-manager';

const log = createLogger('session-branch-pr');

interface PrSnapshotUpdate {
  sessionId: string;
  repoUrl: string | null;
  branch: string | null;
  /** The snapshot in the DB right now — compared against to skip a no-op write. */
  storedPr: string | null;
  /** The snapshot to keep when the lookup can't run (no token, API error). */
  fallbackPr: string | null;
  branchUpdate?: { currentBranch: string };
}

/**
 * Ask GitHub about `branch` and persist the answer on the session. `prCheckedAt`
 * is always written (that's what the TTL reads); the SSE update only fires when a
 * client-visible field actually changed, so a poll that finds nothing new doesn't
 * make every open list re-render.
 */
async function persistPrSnapshot({
  sessionId,
  repoUrl,
  branch,
  storedPr,
  fallbackPr,
  branchUpdate,
}: PrSnapshotUpdate): Promise<void> {
  let pullRequest = fallbackPr;
  if (repoUrl && branch) {
    const pr = await fetchPullRequestForBranch(extractRepoFullName(repoUrl), branch);
    // undefined = lookup unavailable (no token / API error): keep what we had.
    if (pr !== undefined) pullRequest = serializePullRequest(pr);
  }

  const visibleChanges = {
    ...branchUpdate,
    ...(pullRequest !== storedPr ? { pullRequest } : {}),
  };
  const updated = await prisma.session.update({
    where: { id: sessionId },
    data: { ...visibleChanges, prCheckedAt: new Date() },
  });
  if (Object.keys(visibleChanges).length > 0) sseEvents.emitSessionUpdate(sessionId, updated);
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
      select: { repoUrl: true, currentBranch: true, pullRequest: true },
    });
    if (!session) return;

    const detectedBranch = await getCurrentBranch(workingDir);
    const branchChanged = detectedBranch !== null && detectedBranch !== session.currentBranch;

    await persistPrSnapshot({
      sessionId,
      repoUrl: session.repoUrl,
      branch: detectedBranch ?? session.currentBranch,
      storedPr: session.pullRequest,
      // A snapshot belongs to one branch: never carry it over to a new one.
      fallbackPr: branchChanged ? null : session.pullRequest,
      ...(branchChanged ? { branchUpdate: { currentBranch: detectedBranch } } : {}),
    });
  } catch (err) {
    log.debug('Failed to detect branch or check PR', { sessionId, error: toError(err).message });
  }
}

/** Sessions already being refreshed, so concurrent readers make one call, not N. */
const refreshesInFlight = new Set<string>();

async function refreshSessionPr(sessionId: string): Promise<void> {
  // Re-read rather than trusting the caller's row: a turn-end refresh may have
  // landed since it was selected, and this runs after the response was served.
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { repoUrl: true, currentBranch: true, pullRequest: true },
  });
  if (!session) return;

  await persistPrSnapshot({
    sessionId,
    repoUrl: session.repoUrl,
    branch: session.currentBranch,
    storedPr: session.pullRequest,
    fallbackPr: session.pullRequest,
  });
}

/**
 * Re-fetch the PR for every session in a page the client just read whose snapshot
 * has aged out (see {@link isPrSnapshotStale}). Fire-and-forget: the response is
 * already on its way and the fresh row arrives over SSE. Cost is bounded by the
 * page size per TTL, which is why the read path can stay a single query.
 */
export function refreshStalePullRequests(sessions: (PrRefreshCandidate & { id: string })[]): void {
  const now = Date.now();
  for (const session of sessions) {
    if (!isPrSnapshotStale(session, now)) continue;
    if (refreshesInFlight.has(session.id)) continue;

    refreshesInFlight.add(session.id);
    void refreshSessionPr(session.id)
      .catch((err) => {
        log.debug('Failed to refresh PR', { sessionId: session.id, error: toError(err).message });
      })
      .finally(() => refreshesInFlight.delete(session.id));
  }
}
