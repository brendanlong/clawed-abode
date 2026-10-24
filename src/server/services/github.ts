import { z } from 'zod';
import { createLogger, toError } from '@/lib/logger';
import { env } from '@/lib/env';
import { rollUpChecks, type ChecksState, type GitHubPullRequest } from '@/lib/pull-request';
import type { PullRequestComment } from '@/lib/pull-request-watch';
import {
  securityAlertSchemas,
  type ParsedAlert,
  type SecurityAlert,
  type SecurityAlertKind,
} from '@/lib/security-alerts';

const log = createLogger('github');

const GITHUB_API = 'https://api.github.com';

// =============================================================================
// GitHub API helpers
// =============================================================================

/** A 304 is returned rather than thrown only when the caller asked for one with `If-None-Match`. */
export async function githubFetchResponse(
  path: string,
  token?: string,
  extraHeaders?: Record<string, string>
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extraHeaders,
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${GITHUB_API}${path}`, { headers });

  const notModified = response.status === 304 && extraHeaders?.['If-None-Match'] !== undefined;
  if (!response.ok && !notModified) {
    const apiMessage = await readApiMessage(response);
    throw new GitHubApiError(
      response.status,
      path,
      apiMessage,
      isRateLimited(response, apiMessage)
    );
  }

  return response;
}

/** GitHub answers both rate limits with a 403 (or 429), told apart from a permission error by these. */
function isRateLimited(response: Response, apiMessage: string | undefined): boolean {
  return (
    response.status === 429 ||
    response.headers.get('x-ratelimit-remaining') === '0' ||
    response.headers.get('retry-after') !== null ||
    /rate limit/i.test(apiMessage ?? '')
  );
}

/**
 * GitHub puts the actionable reason for a failure in the response body's
 * `message` (e.g. "Resource not accessible by personal access token" when a
 * fine-grained PAT is missing a permission). The status alone can't distinguish
 * that from a rate limit, so carry the message through to the user.
 */
const errorBodySchema = z.object({ message: z.string() });

async function readApiMessage(response: Response): Promise<string | undefined> {
  try {
    const parsed = errorBodySchema.safeParse(await response.json());
    return parsed.success ? parsed.data.message : undefined;
  } catch {
    // Non-JSON error body — the status is all we have.
    return undefined;
  }
}

/** Parse a response body, treating an unexpected shape like any other API failure. */
export async function parseGitHubResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  path: string
): Promise<T> {
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    log.error('Unexpected GitHub response', parsed.error, { path });
    throw new GitHubApiError(502, path, 'Unexpected response from GitHub');
  }
  return parsed.data;
}

const conditionalGetCaches = new Set<ConditionalGetCache<unknown>>();

/**
 * Last parsed answer per path, revalidated with `If-None-Match` and replayed on
 * a 304. GitHub doesn't count an authorized conditional request that comes back
 * 304 against the rate limit. Only use this for lookups that repeat: it stores
 * the parsed value (not the raw body) so entries stay small. Map order is
 * insertion order, so evicting the first key drops the least recently used.
 */
export class ConditionalGetCache<T> {
  private readonly entries = new Map<string, { etag: string; value: T }>();

  constructor(private readonly maxEntries: number) {
    conditionalGetCaches.add(this);
  }

  /** `canReplay` rejects a cached value whose 304 wouldn't prove it's still correct. */
  async fetch(
    path: string,
    token: string,
    parse: (response: Response) => Promise<T>,
    canReplay: (value: T) => boolean = () => true
  ): Promise<T> {
    const entry = this.entries.get(path);
    const cached = entry && canReplay(entry.value) ? entry : undefined;
    const response = await githubFetchResponse(
      path,
      token,
      cached ? { 'If-None-Match': cached.etag } : undefined
    );
    if (response.status === 304 && cached) {
      this.remember(path, cached);
      return cached.value;
    }

    const value = await parse(response);
    const etag = response.headers.get('etag');
    if (etag) {
      this.remember(path, { etag, value });
    } else {
      this.entries.delete(path);
    }
    return value;
  }

  private remember(path: string, entry: { etag: string; value: T }): void {
    this.entries.delete(path);
    this.entries.set(path, entry);
    if (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export function _clearConditionalGetCaches(): void {
  for (const cache of conditionalGetCaches) cache.clear();
}

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly apiMessage?: string,
    public readonly rateLimited = false
  ) {
    super(`GitHub API error: ${status} for ${path}${apiMessage ? `: ${apiMessage}` : ''}`);
    this.name = 'GitHubApiError';
  }
}

export function parseLinkHeader(header: string | null): { next?: string; last?: string } {
  if (!header) return {};

  const links: { next?: string; last?: string } = {};
  const parts = header.split(',');

  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      const [, url, rel] = match;
      if (rel === 'next' || rel === 'last') {
        const pageMatch = url.match(/[?&]page=(\d+)/);
        if (pageMatch) {
          links[rel] = pageMatch[1];
        }
      }
    }
  }

  return links;
}

/** The path and query of a Link header's `next` URL. */
export function nextLinkPath(header: string | null): string | undefined {
  const match = header?.match(/<([^>]+)>;\s*rel="next"/);
  if (!match) return undefined;
  const url = new URL(match[1]);
  return `${url.pathname}${url.search}`;
}

interface LinkedPage<T> {
  items: T[];
  next: string | undefined;
}

/**
 * Every item of a list, following each page's `next` link, so it works for
 * cursor-paginated lists too. Each page is a conditional request; a 304 vouches
 * for the next link as well, since a cursor is derived from the page's items.
 */
async function githubFetchLinkedPages<T>(
  path: string,
  itemSchema: z.ZodType<T>,
  token: string,
  pageCache: ConditionalGetCache<LinkedPage<T>>
): Promise<T[]> {
  const items: T[] = [];
  for (let next: string | undefined = path; next;) {
    const pagePath: string = next;
    const page: LinkedPage<T> = await pageCache.fetch(pagePath, token, async (response) => ({
      items: await parseGitHubResponse(response, z.array(itemSchema), pagePath),
      next: nextLinkPath(response.headers.get('link')),
    }));
    items.push(...page.items);
    next = page.next;
  }
  return items;
}

/** Bounds {@link githubFetchAllPages}: at 100 items a page, 1000 items. */
const MAX_LIST_PAGES = 10;

export interface ListPage<T> {
  items: T[];
  links: { next?: string; last?: string };
}

/**
 * Every item of a paginated GitHub list endpoint, for pickers that search the
 * whole list locally (GitHub's search API can't express "everything I can
 * access"). Page 1's `last` link gives the page count, so the rest are fetched
 * in parallel. `truncated` means pages past the cap were skipped.
 */
export async function githubFetchAllPages<T>(
  path: string,
  itemSchema: z.ZodType<T>,
  token: string,
  pageCache: ConditionalGetCache<ListPage<T>>
): Promise<{ items: T[]; truncated: boolean }> {
  const pageSchema = z.array(itemSchema);
  const perPage = 100;
  const fetchPage = (page: number, canReplay?: (cached: ListPage<T>) => boolean) =>
    pageCache.fetch(
      `${path}${path.includes('?') ? '&' : '?'}per_page=${perPage}&page=${page}`,
      token,
      async (response) => ({
        items: await parseGitHubResponse(response, pageSchema, path),
        links: parseLinkHeader(response.headers.get('link')),
      }),
      canReplay
    );

  // A 304 vouches for the body, not the Link header: if page 1 is full, later
  // pages could have grown while page 1 stayed the same, so refetch it for an
  // accurate page count. A partial page 1 is the whole list, so its 304 is exact.
  const first = await fetchPage(1, (cached) => cached.items.length < perPage);
  const { links } = first;
  // Without `last` the page count is unknown; keep page 1 and admit the gap.
  const lastPage = links.last ? Number(links.last) : links.next ? Infinity : 1;
  const pageCount = links.last ? Math.min(lastPage, MAX_LIST_PAGES) : 1;
  const rest = await Promise.all(Array.from({ length: pageCount - 1 }, (_, i) => fetchPage(i + 2)));

  return {
    items: [first, ...rest].flatMap((page) => page.items),
    truncated: lastPage > MAX_LIST_PAGES,
  };
}

// =============================================================================
// PR lookup
// =============================================================================

const prLookupCache = new ConditionalGetCache<GitHubPullRequest | null>(500);
const openPrPageCache = new ConditionalGetCache<ListPage<GitHubPullRequest>>(200);
const checkRunsCache = new ConditionalGetCache<z.infer<typeof checkRunsSchema>>(500);
const commitStatusCache = new ConditionalGetCache<z.infer<typeof commitStatusSchema>>(500);

const pullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().default(false),
  merged_at: z.string().nullable(),
  html_url: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  updated_at: z.string(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string(), repo: z.object({ default_branch: z.string() }) }),
});
const pullRequestListSchema = z.array(pullRequestSchema);

const checkRunsSchema = z.object({
  check_runs: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })),
});
const commitStatusSchema = z.object({ statuses: z.array(z.object({ state: z.string() })) });

function toGitHubPullRequest(pr: z.infer<typeof pullRequestSchema>): GitHubPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.merged_at ? 'merged' : pr.state,
    draft: pr.draft,
    url: pr.html_url,
    author: pr.user?.login || 'unknown',
    updatedAt: pr.updated_at,
    headBranch: pr.head.ref,
    headSha: pr.head.sha,
    stackedOn: pr.base.ref === pr.base.repo.default_branch ? null : pr.base.ref,
  };
}

function requireToken(): string {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not configured');
  return token;
}

/**
 * Fetch the most recent pull request for a given branch.
 * Returns null if no PR exists for the branch.
 * Returns undefined if the GitHub token is not configured or the lookup failed.
 */
export async function fetchPullRequestForBranch(
  repoFullName: string,
  branch: string
): Promise<GitHubPullRequest | null | undefined> {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    return undefined;
  }

  const [owner] = repoFullName.split('/');
  const headFilter = `${owner}:${branch}`;
  const path = `/repos/${repoFullName}/pulls?head=${encodeURIComponent(headFilter)}&state=all&per_page=1&sort=updated&direction=desc`;

  try {
    return await prLookupCache.fetch(path, token, async (response) => {
      const pulls = await parseGitHubResponse(response, pullRequestListSchema, path);
      return pulls.length > 0 ? toGitHubPullRequest(pulls[0]) : null;
    });
  } catch (err) {
    log.error('Failed to fetch PR for branch', toError(err), {
      repoFullName,
      branch,
    });
    return undefined;
  }
}

/** Every open PR in a repo (up to the page cap). Throws when the lookup fails. */
export async function fetchOpenPullRequests(repoFullName: string): Promise<GitHubPullRequest[]> {
  const path = `/repos/${repoFullName}/pulls?state=open`;
  const { items } = await githubFetchAllPages(
    path,
    pullRequestSchema.transform(toGitHubPullRequest),
    requireToken(),
    openPrPageCache
  );
  return items;
}

/** One PR by number. Throws when the lookup fails. */
export async function fetchPullRequest(
  repoFullName: string,
  number: number
): Promise<GitHubPullRequest> {
  const path = `/repos/${repoFullName}/pulls/${number}`;
  const pr = await prLookupCache.fetch(path, requireToken(), async (response) =>
    toGitHubPullRequest(await parseGitHubResponse(response, pullRequestSchema, path))
  );
  if (!pr) throw new Error(`No pull request at ${path}`);
  return pr;
}

// =============================================================================
// PR comments
// =============================================================================

const commentPageCache = new ConditionalGetCache<PullRequestComment[]>(200);

const commentFields = {
  id: z.number(),
  html_url: z.string(),
  body: z.string().nullable(),
  user: z.object({ login: z.string(), type: z.string() }).nullable(),
  author_association: z.string(),
  created_at: z.string(),
};
const issueCommentSchema = z.object({ ...commentFields, issue_url: z.string() });
const reviewCommentSchema = z.object({
  ...commentFields,
  pull_request_url: z.string(),
  path: z.string(),
});

function trailingNumber(url: string): number {
  return Number(url.slice(url.lastIndexOf('/') + 1));
}

/** Bots (dependabot, github-actions, CI reporters) aren't people talking about the PR. */
function fromPerson(comment: { user: { type: string } | null }): boolean {
  return comment.user?.type !== 'Bot';
}

function toComment(
  comment: z.infer<typeof issueCommentSchema> | z.infer<typeof reviewCommentSchema>,
  fields: Pick<PullRequestComment, 'key' | 'number' | 'path'>
): PullRequestComment {
  return {
    ...fields,
    author: comment.user?.login ?? 'ghost',
    association: comment.author_association,
    body: comment.body ?? '',
    url: comment.html_url,
    createdAt: comment.created_at,
  };
}

/**
 * The repo's newest comments by people: conversation comments (on PRs and
 * issues alike; GitHub doesn't tell them apart here) and inline review comments.
 * One page of each, so a watch polled every minute misses only comments past
 * the 100th in that minute. Unchanged pages are free conditional requests.
 * Throws when either can't be read.
 */
export async function fetchRecentComments(repoFullName: string): Promise<PullRequestComment[]> {
  const token = requireToken();
  const recent = '?sort=created&direction=desc&per_page=100';
  const issuePath = `/repos/${repoFullName}/issues/comments${recent}`;
  const reviewPath = `/repos/${repoFullName}/pulls/comments${recent}`;
  const [conversation, review] = await Promise.all([
    commentPageCache.fetch(issuePath, token, async (response) =>
      (await parseGitHubResponse(response, z.array(issueCommentSchema), issuePath))
        .filter(fromPerson)
        .map((c) =>
          toComment(c, { key: `comment:${c.id}`, number: trailingNumber(c.issue_url), path: null })
        )
    ),
    commentPageCache.fetch(reviewPath, token, async (response) =>
      (await parseGitHubResponse(response, z.array(reviewCommentSchema), reviewPath))
        .filter(fromPerson)
        .map((c) =>
          toComment(c, {
            key: `review-comment:${c.id}`,
            number: trailingNumber(c.pull_request_url),
            path: c.path,
          })
        )
    ),
  ]);
  return [...conversation, ...review];
}

/**
 * The CI rollup for a commit, from its check runs (Actions and other apps) and
 * commit statuses (older integrations). Null when the token can't read them (a
 * fine-grained token needs Checks and Commit statuses read access); any other
 * failure throws, so a transient error never reads as "unknown".
 */
export async function fetchChecks(repoFullName: string, sha: string): Promise<ChecksState | null> {
  const token = env.GITHUB_TOKEN;
  if (!token) return null;
  const runsPath = `/repos/${repoFullName}/commits/${sha}/check-runs?per_page=100`;
  const statusPath = `/repos/${repoFullName}/commits/${sha}/status`;
  try {
    const [runs, status] = await Promise.all([
      checkRunsCache.fetch(runsPath, token, (response) =>
        parseGitHubResponse(response, checkRunsSchema, runsPath)
      ),
      commitStatusCache.fetch(statusPath, token, (response) =>
        parseGitHubResponse(response, commitStatusSchema, statusPath)
      ),
    ]);
    return rollUpChecks(runs.check_runs, status.statuses);
  } catch (err) {
    const unreadable =
      err instanceof GitHubApiError &&
      !err.rateLimited &&
      (err.status === 403 || err.status === 404);
    if (unreadable) {
      log.debug('Checks are not readable', { repoFullName, sha, error: toError(err).message });
      return null;
    }
    throw err;
  }
}

// =============================================================================
// Security alerts
// =============================================================================

const alertPageCache = new ConditionalGetCache<LinkedPage<ParsedAlert>>(200);

/** A repo's open alerts of one kind. Throws when they can't be read (including when the feature is off). */
export async function fetchOpenSecurityAlerts(
  repoFullName: string,
  kind: SecurityAlertKind
): Promise<SecurityAlert[]> {
  const pages = await githubFetchLinkedPages(
    `/repos/${repoFullName}/${kind}/alerts?state=open&per_page=100`,
    securityAlertSchemas[kind],
    requireToken(),
    alertPageCache
  );
  return pages.map((parsed) => parsed.alert);
}

/** One alert as it is now; null if it no longer exists. */
export async function fetchSecurityAlert(
  repoFullName: string,
  kind: SecurityAlertKind,
  number: number
): Promise<ParsedAlert | null> {
  const path = `/repos/${repoFullName}/${kind}/alerts/${number}`;
  try {
    const response = await githubFetchResponse(path, requireToken());
    return await parseGitHubResponse(response, securityAlertSchemas[kind], path);
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return null;
    throw err;
  }
}
