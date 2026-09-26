import { z } from 'zod';
import { createLogger, toError } from '@/lib/logger';
import { env } from '@/lib/env';
import type { PullRequestInfo } from '@/lib/pull-request';

const log = createLogger('github');

const GITHUB_API = 'https://api.github.com';

// =============================================================================
// Shared types
// =============================================================================

interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged_at: string | null;
  html_url: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

// =============================================================================
// GitHub API helpers
// =============================================================================

export async function githubFetchResponse(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${GITHUB_API}${path}`, { headers });

  if (!response.ok) {
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

export async function githubFetch<T>(path: string, token?: string): Promise<T> {
  const response = await githubFetchResponse(path, token);
  return response.json();
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

/**
 * Every item of a paginated GitHub list endpoint, for pickers that search the
 * whole list locally (GitHub's search API can't express "everything I can
 * access"). Page 1's `last` link gives the page count, so the rest are fetched
 * in parallel. `truncated` means pages past the cap were skipped.
 */
export async function githubFetchAllPages<T>(
  path: string,
  itemSchema: z.ZodType<T>,
  token: string
): Promise<{ items: T[]; truncated: boolean }> {
  const pageSchema = z.array(itemSchema);
  const pageUrl = (page: number) =>
    `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`;

  const first = await githubFetchResponse(pageUrl(1), token);
  const lastPage = Number(parseLinkHeader(first.headers.get('link')).last ?? 1);
  const pageCount = Math.min(lastPage, MAX_LIST_PAGES);
  const rest = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, i) => githubFetch<unknown>(pageUrl(i + 2), token))
  );

  const items = [await first.json(), ...rest].flatMap((page) => pageSchema.parse(page));
  return { items, truncated: lastPage > MAX_LIST_PAGES };
}

// =============================================================================
// PR lookup
// =============================================================================

/**
 * Fetch the most recent pull request for a given branch.
 * Returns null if no PR exists for the branch.
 * Returns undefined if the GitHub token is not configured.
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

  try {
    const pulls = await githubFetch<GitHubPullRequest[]>(
      `/repos/${repoFullName}/pulls?head=${encodeURIComponent(headFilter)}&state=all&per_page=1&sort=updated&direction=desc`,
      token
    );

    if (pulls.length === 0) {
      return null;
    }

    const pr = pulls[0];
    return {
      number: pr.number,
      title: pr.title,
      state: pr.merged_at ? 'merged' : pr.state,
      draft: pr.draft,
      url: pr.html_url,
      author: pr.user?.login || 'unknown',
      updatedAt: pr.updated_at,
    };
  } catch (err) {
    log.error('Failed to fetch PR for branch', toError(err), {
      repoFullName,
      branch,
    });
    return undefined;
  }
}
