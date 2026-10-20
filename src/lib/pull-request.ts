import { z } from 'zod';

/** The CI rollup for a PR's head commit: `none` means it has no checks at all. */
export const CHECKS_STATES = ['pending', 'success', 'failure', 'none'] as const;
export type ChecksState = (typeof CHECKS_STATES)[number];

export const pullRequestInfoSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  url: z.string(),
  author: z.string(),
  updatedAt: z.string(),
  headBranch: z.string(),
  headSha: z.string(),
  /** The base branch when it isn't the repo's default, i.e. the PR is stacked on another. */
  stackedOn: z.string().nullable(),
  /** For `headSha`; null when unknown (not fetched yet, or the token can't read checks). */
  checks: z.enum(CHECKS_STATES).nullable(),
});

export type PullRequestInfo = z.infer<typeof pullRequestInfoSchema>;
export type PrState = PullRequestInfo['state'];
/** A PR as GitHub's pulls endpoints describe it; the checks come from separate calls. */
export type GitHubPullRequest = Omit<PullRequestInfo, 'checks'>;

/**
 * Stored checks a lookup can keep instead of refetching: only a finished PR's,
 * for the same head commit. An open PR's are always refetched (unchanged ones
 * are free), since even settled checks can change without a push: a re-run, a
 * chained workflow, or CI that registers late. Undefined means fetch.
 */
export function reusableChecks(
  fetched: GitHubPullRequest,
  stored: PullRequestInfo | null
): PullRequestInfo['checks'] | undefined {
  if (!stored || stored.headSha !== fetched.headSha || fetched.state === 'open') return undefined;
  return stored.checks;
}

/** CI providers take a while after a push to register their first check. */
export const NO_CHECKS_GRACE_MS = 2 * 60 * 1000;

/**
 * "No checks" right after the PR changed most likely means CI hasn't registered
 * yet, so it counts as pending until the grace period passes.
 */
export function settleChecks(
  checks: ChecksState | null,
  prUpdatedAt: string,
  nowMs: number
): ChecksState | null {
  const recent = nowMs - Date.parse(prUpdatedAt) < NO_CHECKS_GRACE_MS;
  return checks === 'none' && recent ? 'pending' : checks;
}

const CHECKS_DESCRIPTIONS: Record<ChecksState, string> = {
  pending: 'CI running',
  success: 'CI passed',
  failure: 'CI failed',
  none: 'no CI checks',
};

export function describeChecks(checks: ChecksState | null): string {
  return checks ? CHECKS_DESCRIPTIONS[checks] : 'CI status unknown';
}

/** GitHub repo names are case-insensitive; PullRequest and PullRequestWatch rows key on this. */
export function pullRequestRepoKey(repoFullName: string): string {
  return repoFullName.toLowerCase();
}

/**
 * Decode a `PullRequest.info` / `Session.pullRequest` JSON column. Unparseable or
 * absent values read as "no PR" so a bad row can never break the session list.
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

const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * Roll a commit's check runs and commit statuses up into one state. A failure
 * wins even while other checks still run, since it can't turn green without a
 * re-run; any conclusion we don't know counts as a failure rather than a pass.
 */
export function rollUpChecks(
  checkRuns: { status: string; conclusion: string | null }[],
  statuses: { state: string }[]
): ChecksState {
  const runStates = checkRuns.map((run): ChecksState => {
    if (run.status !== 'completed') return 'pending';
    return run.conclusion && PASSING_CONCLUSIONS.has(run.conclusion) ? 'success' : 'failure';
  });
  const statusStates = statuses.map(({ state }): ChecksState =>
    state === 'success' ? 'success' : state === 'pending' ? 'pending' : 'failure'
  );
  const all = [...runStates, ...statusStates];
  if (all.includes('failure')) return 'failure';
  if (all.includes('pending')) return 'pending';
  return all.length > 0 ? 'success' : 'none';
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
const CREATE_PR_COMMAND = /\bgh\b[^;&|\n]*\spr\s+(?:create|new)\b/;
const CREATE_PR_MCP_TOOL = /^mcp__.+__create_pull_request$/;
const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

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

export interface PullRequestRef {
  repoFullName: string;
  number: number;
}

/**
 * The PRs a finished tool call created, read from the URLs in its output
 * (`gh pr create` prints one; the GitHub MCP tool returns one). This finds a
 * session's PRs in any repo, not just on its clone's current branch.
 */
export function createdPullRequests(
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown
): PullRequestRef[] {
  const creates =
    CREATE_PR_MCP_TOOL.test(toolName) ||
    (toolName === 'Bash' &&
      CREATE_PR_COMMAND.test(bashInputSchema.safeParse(toolInput).data?.command ?? ''));
  if (!creates) return [];
  const refs = new Map<string, PullRequestRef>();
  for (const [, repoFullName, number] of JSON.stringify(toolResponse ?? null).matchAll(PR_URL)) {
    refs.set(`${pullRequestRepoKey(repoFullName)}#${number}`, {
      repoFullName,
      number: Number(number),
    });
  }
  return [...refs.values()];
}
