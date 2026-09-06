import { prisma } from '@/lib/prisma';
import { createLogger, toError } from '@/lib/logger';
import { extractRepoFullName } from '@/lib/utils';
import { serializePullRequest } from '@/lib/pull-request';
import { sseEvents } from './events';
import { fetchPullRequestForBranch } from './github';
import { getCurrentBranch } from './worktree-manager';

const log = createLogger('session-branch-pr');

/**
 * Detect a branch change and refresh the persisted PR status for the session
 * (fire-and-forget, called at each turn end). PR status lives on the Session row
 * so the list never has to ask GitHub; one `session_update` carries both fields.
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
    const branchForPr = detectedBranch ?? session.currentBranch;

    // A snapshot belongs to one branch: never carry it over to a new one.
    let pullRequest = branchChanged ? null : session.pullRequest;
    if (session.repoUrl && branchForPr) {
      const pr = await fetchPullRequestForBranch(extractRepoFullName(session.repoUrl), branchForPr);
      // undefined = lookup unavailable (no token / API error): keep what we had.
      if (pr !== undefined) pullRequest = serializePullRequest(pr);
    }

    const data = {
      ...(branchChanged ? { currentBranch: detectedBranch } : {}),
      ...(pullRequest !== session.pullRequest ? { pullRequest } : {}),
    };
    if (Object.keys(data).length === 0) return;

    const updated = await prisma.session.update({ where: { id: sessionId }, data });
    sseEvents.emitSessionUpdate(sessionId, updated);
  } catch (err) {
    log.debug('Failed to detect branch or check PR', { sessionId, error: toError(err).message });
  }
}
