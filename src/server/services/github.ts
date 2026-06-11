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

// =============================================================================
// Repo / branch / issue listing (shared by the tRPC router and the abode CLI)
// =============================================================================

interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  private: boolean;
  default_branch: string;
  updated_at: string;
}

interface GitHubBranch {
  name: string;
  protected: boolean;
}

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  user: { login: string } | null;
  labels: Array<{ name: string; color: string }>;
  comments: number;
  created_at: string;
  updated_at: string;
}

export interface RepoSummary {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
}

export interface BranchSummary {
  name: string;
  protected: boolean;
}

export interface IssueSummary {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  author: string;
  labels: Array<{ name: string; color: string }>;
  comments: number;
  createdAt: string;
  updatedAt: string;
}

function mapIssue(issue: GitHubIssue): IssueSummary {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    author: issue.user?.login || 'unknown',
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    comments: issue.comments,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  };
}

/**
 * List the authenticated user's repositories, optionally filtered by search.
 */
export async function listRepos(
  options: { search?: string; page?: number; perPage?: number },
  token: string
): Promise<{ repos: RepoSummary[]; nextPage?: number }> {
  const page = options.page ?? 1;
  const perPage = options.perPage ?? 30;

  let repos: GitHubRepo[];
  let response: Response;

  if (options.search) {
    const query = encodeURIComponent(`${options.search} in:name user:@me`);
    response = await githubFetchResponse(
      `/search/repositories?q=${query}&per_page=${perPage}&page=${page}`,
      token
    );
    const data = await response.json();
    repos = data.items;
  } else {
    response = await githubFetchResponse(
      `/user/repos?sort=updated&per_page=${perPage}&page=${page}`,
      token
    );
    repos = await response.json();
  }

  const links = parseLinkHeader(response.headers.get('link'));

  return {
    repos: repos.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      name: r.name,
      owner: r.owner.login,
      description: r.description,
      private: r.private,
      defaultBranch: r.default_branch,
      updatedAt: r.updated_at,
    })),
    nextPage: links.next ? parseInt(links.next, 10) : undefined,
  };
}

/**
 * List branches for a repository along with its default branch.
 */
export async function listBranches(
  repoFullName: string,
  token: string
): Promise<{ branches: BranchSummary[]; defaultBranch: string }> {
  const repo = await githubFetch<GitHubRepo>(`/repos/${repoFullName}`, token);
  const branches = await githubFetch<GitHubBranch[]>(
    `/repos/${repoFullName}/branches?per_page=100`,
    token
  );

  return {
    branches: branches.map((b) => ({ name: b.name, protected: b.protected })),
    defaultBranch: repo.default_branch,
  };
}

/**
 * List issues for a repository (pull requests filtered out).
 */
export async function listIssues(
  options: {
    repoFullName: string;
    search?: string;
    state?: 'open' | 'closed' | 'all';
    page?: number;
    perPage?: number;
  },
  token: string
): Promise<{ issues: IssueSummary[]; nextPage?: number }> {
  const page = options.page ?? 1;
  const perPage = options.perPage ?? 30;
  const state = options.state ?? 'open';

  let issues: GitHubIssue[];
  let response: Response;

  if (options.search) {
    const query = encodeURIComponent(
      `${options.search} repo:${options.repoFullName} is:issue state:${state}`
    );
    response = await githubFetchResponse(
      `/search/issues?q=${query}&per_page=${perPage}&page=${page}`,
      token
    );
    const data = await response.json();
    issues = data.items;
  } else {
    response = await githubFetchResponse(
      `/repos/${options.repoFullName}/issues?state=${state}&per_page=${perPage}&page=${page}&sort=updated&direction=desc`,
      token
    );
    issues = await response.json();
  }

  // GitHub returns pull requests from the issues endpoint — filter them out
  issues = issues.filter((issue) => !('pull_request' in issue));

  const links = parseLinkHeader(response.headers.get('link'));

  return {
    issues: issues.map(mapIssue),
    nextPage: links.next ? parseInt(links.next, 10) : undefined,
  };
}

/**
 * Get a single issue.
 */
export async function getIssue(
  repoFullName: string,
  issueNumber: number,
  token: string
): Promise<IssueSummary> {
  const issue = await githubFetch<GitHubIssue>(
    `/repos/${repoFullName}/issues/${issueNumber}`,
    token
  );
  return mapIssue(issue);
}
