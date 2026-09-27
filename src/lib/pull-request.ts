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

/**
 * How long a `Session.pullRequest` snapshot is trusted before it's re-fetched.
 * Short because unchanged re-fetches are free (see `fetchPullRequestForBranch`).
 */
export const PR_SNAPSHOT_TTL_MS = 60 * 1000;

/**
 * A merged PR can't change — but the column is keyed by *branch*, and a branch
 * can get a second PR after the first merges, so this is a long TTL rather than
 * "never look again".
 */
export const MERGED_PR_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

export interface PrRefreshCandidate {
  id: string;
  status: string;
  repoUrl: string | null;
  currentBranch: string | null;
  pullRequest: PullRequestInfo | null;
  prCheckedAt: Date | null;
}

/**
 * Whether a session's PR snapshot has aged out and should be re-fetched the next
 * time a client reads the session. Archived sessions are read-only history and a
 * session with no repo or branch has nothing to look up.
 *
 * Why poll at all: see "Session list" in doc/messages-and-sse.md.
 */
export function isPrSnapshotStale(session: PrRefreshCandidate, now: number): boolean {
  if (session.status === 'archived') return false;
  if (!session.repoUrl || !session.currentBranch) return false;

  const ttlMs =
    session.pullRequest?.state === 'merged' ? MERGED_PR_SNAPSHOT_TTL_MS : PR_SNAPSHOT_TTL_MS;
  return session.prCheckedAt === null || now - session.prCheckedAt.getTime() >= ttlMs;
}

const BRANCH_OR_PR_COMMAND = new RegExp(
  [
    String.raw`\bgit\b[^;&|\n]*\s(?:checkout|switch|push|merge|branch\s+-[mM])\b`,
    String.raw`\bgh\b[^;&|\n]*\spr\s+(?:create|new|checkout|merge|close|reopen|ready|edit)\b`,
  ].join('|')
);
const PR_MCP_TOOL = /^mcp__.+__(?:create|merge|update)_pull_request/;

const bashInputSchema = z.object({
  command: z.string(),
  run_in_background: z.boolean().optional(),
});

/**
 * Whether a finished tool call may have moved the session's branch or changed
 * its PR, so the snapshot should be refreshed now rather than at turn end. False
 * positives only cost one (usually free) lookup. Backgrounded Bash is skipped:
 * its hook fires at launch, before the command has done anything.
 */
export function mayChangeBranchOrPr(toolName: string, toolInput: unknown): boolean {
  if (PR_MCP_TOOL.test(toolName)) return true;
  if (toolName !== 'Bash') return false;
  const parsed = bashInputSchema.safeParse(toolInput);
  return (
    parsed.success &&
    !parsed.data.run_in_background &&
    BRANCH_OR_PR_COMMAND.test(parsed.data.command)
  );
}
