/** Pure parts of PR watches (src/server/services/pull-request-watch.ts). */

import { describeChecks, type PullRequestInfo } from './pull-request';

/** Marks a PR the watch has seen open, which is what makes its merge or close reportable. */
export const SEEN_KEY = 'seen';

/** The keys {@link watchEventKey} gives a PR that can't change any more. */
export const FINISHED_KEYS = ['merged', 'closed'] as const;

/**
 * The state of a PR a watch reports, once per value: ready (open, not a draft,
 * CI finished) at a head commit with its CI outcome, merged, or closed. Null
 * while there's nothing to report. Unknown checks (the token can't read them)
 * count as finished, or a watch on such a repo would never report anything.
 * A watch on one PR also reports its drafts, since its author is usually
 * waiting on CI before marking it ready.
 */
export function watchEventKey(
  pr: PullRequestInfo,
  { includeDrafts }: { includeDrafts: boolean }
): string | null {
  if (pr.state !== 'open') return pr.state;
  if ((pr.draft && !includeDrafts) || pr.checks === 'pending') return null;
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
  turnActive: boolean;
}

/** A person's comment on a PR: a conversation comment or an inline review comment. */
export interface PullRequestComment {
  /** Its watch event key; the two kinds have separate id spaces. */
  key: string;
  number: number;
  author: string;
  /** GitHub's author_association, e.g. OWNER, COLLABORATOR, NONE. */
  association: string;
  /** The file an inline review comment is on; null for a conversation comment. */
  path: string | null;
  body: string;
  url: string;
  createdAt: string;
}

export interface WatchedPullRequest {
  repoFullName: string;
  info: PullRequestInfo;
  /** Sessions whose current branch is this PR's, i.e. the ones that wrote it. */
  sessions: PullRequestAuthorSession[];
  /** Comments not reported before, oldest first. */
  comments: PullRequestComment[];
}

const EXCERPT_LINES = 3;
const EXCERPT_CHARS = 500;

/** The first few non-blank lines, marked when there's more. */
export function commentExcerpt(body: string): string[] {
  const lines = body
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  const shown: string[] = [];
  let chars = 0;
  for (const line of lines.slice(0, EXCERPT_LINES)) {
    if (chars + line.length > EXCERPT_CHARS) {
      shown.push(`${line.slice(0, EXCERPT_CHARS - chars)}…`);
      return shown;
    }
    shown.push(line);
    chars += line.length;
  }
  if (lines.length > EXCERPT_LINES) shown.push('…');
  return shown;
}

function formatComment(comment: PullRequestComment): string {
  const where = comment.path ? ` on ${comment.path}` : '';
  const header = `  Comment by ${comment.author} (${comment.association.toLowerCase()})${where}, ${comment.url}:`;
  return [header, ...commentExcerpt(comment.body).map((line) => `    > ${line}`)].join('\n');
}

function formatSession(session: PullRequestAuthorSession): string {
  const reach = session.agentName
    ? `; message it with SendMessage to ${JSON.stringify(session.agentName)}`
    : '';
  const activity = session.status === 'running' ? (session.turnActive ? ', busy' : ', idle') : '';
  return `  From session ${JSON.stringify(session.name)} (${session.id}, ${session.status}${activity})${reach}.`;
}

export function formatWatchedPullRequest({
  repoFullName,
  info,
  sessions,
  comments,
}: WatchedPullRequest): string {
  const stacked = info.stackedOn ? `, stacked on ${info.stackedOn}` : '';
  const line = `- ${repoFullName}#${info.number} ${JSON.stringify(info.title)} by ${info.author}: ${describePullRequestState(info)} (head ${info.headSha.slice(0, 7)}, updated ${info.updatedAt.slice(0, 10)}${stacked}) ${info.url}`;
  return [line, ...sessions.map(formatSession), ...comments.map(formatComment)].join('\n');
}

/** The message a watching session gets for the PRs that changed since the last one. */
export function formatWatchMessage(prs: WatchedPullRequest[]): string {
  const quoted = prs.some((pr) => pr.comments.length > 0)
    ? ' Comments are quoted from GitHub as written by their authors.'
    : '';
  return `[From a pull request watch you set up, not from the user.${quoted}]\n\n${prs.map(formatWatchedPullRequest).join('\n')}`;
}
