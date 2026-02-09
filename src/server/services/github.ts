import { createLogger } from '@/lib/logger';
import { env } from '@/lib/env';

const log = createLogger('github');

const GITHUB_API = 'https://api.github.com';

// =============================================================================
// Shared types
// =============================================================================

export type PrState = 'open' | 'closed' | 'merged';

export interface PullRequestInfo {
  number: number;
  title: string;
  state: PrState;
  draft: boolean;
  url: string;
  author: string;
  updatedAt: string;
}

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
    throw new GitHubApiError(response.status, path);
  }

  return response;
}

export async function githubFetch<T>(path: string, token?: string): Promise<T> {
  const response = await githubFetchResponse(path, token);
  return response.json();
}

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string
  ) {
    super(`GitHub API error: ${status} for ${path}`);
    this.name = 'GitHubApiError';
  }
}

export function parseLinkHeader(header: string | null): { next?: string } {
  if (!header) return {};

  const links: { next?: string } = {};
  const parts = header.split(',');

  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      const [, url, rel] = match;
      if (rel === 'next') {
        const pageMatch = url.match(/[?&]page=(\d+)/);
        if (pageMatch) {
          links.next = pageMatch[1];
        }
      }
    }
  }

  return links;
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
    log.error('Failed to fetch PR for branch', err instanceof Error ? err : undefined, {
      repoFullName,
      branch,
    });
    return undefined;
  }
}
