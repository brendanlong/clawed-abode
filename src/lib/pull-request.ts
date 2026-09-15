import { z } from 'zod';

export const pullRequestInfoSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  url: z.string(),
  author: z.string(),
  updatedAt: z.string(),
});

export type PullRequestInfo = z.infer<typeof pullRequestInfoSchema>;
export type PrState = PullRequestInfo['state'];

/**
 * Decode the `Session.pullRequest` JSON column. Unparseable or absent values read
 * as "no PR" so a bad row can never break the session list.
 */
export function parsePullRequestJson(json: string | null): PullRequestInfo | null {
  if (!json) return null;
  try {
    const parsed = pullRequestInfoSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function serializePullRequest(pullRequest: PullRequestInfo | null): string | null {
  return pullRequest ? JSON.stringify(pullRequest) : null;
}

/** How long a `Session.pullRequest` snapshot is trusted before it's re-fetched. */
export const PR_SNAPSHOT_TTL_MS = 5 * 60 * 1000;

export interface PrRefreshCandidate {
  repoUrl: string | null;
  currentBranch: string | null;
  pullRequest: PullRequestInfo | null;
  prCheckedAt: Date | null;
}

/**
 * Whether a session's PR snapshot should be re-fetched when the client looks at
 * it. The turn-end refresh alone leaves a session stale forever once the agent
 * stops working (a PR opened, reviewed or merged afterwards never lands), and
 * GitHub can't push to us — the server isn't reachable from the internet — so
 * freshness has to come from polling what's actually on screen.
 *
 * `prCheckedAt` is stamped even when the lookup fails, so a repo the token can't
 * read costs one call per TTL rather than one per list request. A merged PR is
 * terminal: nothing about it can change again, so it's never re-fetched.
 */
export function isPrSnapshotStale(
  session: PrRefreshCandidate,
  now: number,
  ttlMs: number = PR_SNAPSHOT_TTL_MS
): boolean {
  if (!session.repoUrl || !session.currentBranch) return false;
  if (session.pullRequest?.state === 'merged') return false;
  return session.prCheckedAt === null || now - session.prCheckedAt.getTime() >= ttlMs;
}
