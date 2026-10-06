import { z } from 'zod';
import { createLogger, toError } from '@/lib/logger';
import { env } from '@/lib/env';
import type { PullRequestInfo } from '@/lib/pull-request';

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
    throw new GitHubApiError(response.status, path, await readApiMessage(response));
  }

  return response;
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
    public readonly apiMessage?: string
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

const prLookupCache = new ConditionalGetCache<PullRequestInfo | null>(500);

const pullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  merged_at: z.string().nullable(),
  html_url: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  updated_at: z.string(),
});
const pullRequestListSchema = z.array(pullRequestSchema);

function toPullRequestInfo(pr: z.infer<typeof pullRequestSchema>): PullRequestInfo {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.merged_at ? 'merged' : pr.state,
    draft: pr.draft,
    url: pr.html_url,
    author: pr.user?.login || 'unknown',
    updatedAt: pr.updated_at,
  };
}

/**
 * Fetch the most recent pull request for a given branch.
 * Returns null if no PR exists for the branch.
 * Returns undefined if the GitHub token is not configured or the lookup failed.
 */
export async function fetchPullRequestForBranch(
  repoFullName: string,
  branch: string
): Promise<PullRequestInfo | null | undefined> {
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
      return pulls.length > 0 ? toPullRequestInfo(pulls[0]) : null;
    });
  } catch (err) {
    log.error('Failed to fetch PR for branch', toError(err), {
      repoFullName,
      branch,
    });
    return undefined;
  }
}
