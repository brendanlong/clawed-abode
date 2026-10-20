/** Pure parts of PR watches (src/server/services/pull-request-watch.ts). */

import { describeChecks, type PullRequestInfo } from './pull-request';

/** Marks a PR the watch has seen open, which is what makes its merge or close reportable. */
export const SEEN_KEY = 'seen';

/**
 * The state of a PR a watch reports, once per value: ready (open, not a draft,
 * CI finished) at a head commit with its CI outcome, merged, or closed. Null
 * while there's nothing to report. Unknown checks (the token can't read them)
 * count as finished, or a watch on such a repo would never report anything.
 */
export function watchEventKey(pr: PullRequestInfo): string | null {
  if (pr.state !== 'open') return pr.state;
  if (pr.draft || pr.checks === 'pending') return null;
  return `ready:${pr.headSha}:${pr.checks ?? 'unknown'}`;
}

export function describePullRequestState(pr: PullRequestInfo): string {
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed without merging';
  const checks = describeChecks(pr.checks);
  return pr.draft ? `draft, ${checks}` : `ready for review, ${checks}`;
}

export interface PullRequestAuthorSession {
  id: string;
  name: string;
  status: string;
  agentName: string | null;
}

export interface WatchedPullRequest {
  repoFullName: string;
  info: PullRequestInfo;
  /** Sessions whose current branch is this PR's, i.e. the ones that wrote it. */
  sessions: PullRequestAuthorSession[];
}

function formatSession(session: PullRequestAuthorSession): string {
  const reach = session.agentName
    ? `; message it with SendMessage to ${JSON.stringify(session.agentName)}`
    : '';
  return `  From session ${JSON.stringify(session.name)} (${session.id}, ${session.status})${reach}.`;
}

export function formatWatchedPullRequest({
  repoFullName,
  info,
  sessions,
}: WatchedPullRequest): string {
  const line = `- ${repoFullName}#${info.number} ${JSON.stringify(info.title)} by ${info.author}: ${describePullRequestState(info)} (head ${info.headSha.slice(0, 7)}) ${info.url}`;
  return [line, ...sessions.map(formatSession)].join('\n');
}

/** The message a watching session gets for the PRs that changed since the last one. */
export function formatWatchMessage(prs: WatchedPullRequest[]): string {
  return `[From the pull request watcher you set up with watch_pull_requests, not from the user.]\n\n${prs.map(formatWatchedPullRequest).join('\n')}`;
}
