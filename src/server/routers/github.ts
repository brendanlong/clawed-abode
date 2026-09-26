import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { TRPCError } from '@trpc/server';
import { env } from '@/lib/env';
import { defaultBranchFirst } from '@/lib/branch-list';
import {
  githubFetch as serviceGithubFetch,
  githubFetchResponse as serviceGithubFetchResponse,
  githubFetchAllPages as serviceGithubFetchAllPages,
  parseLinkHeader,
  GitHubApiError,
} from '../services/github';

const repoSchema = z.object({
  id: z.number(),
  full_name: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
  description: z.string().nullable(),
  private: z.boolean(),
  default_branch: z.string(),
});
type GitHubRepo = z.infer<typeof repoSchema>;

const branchSchema = z.object({ name: z.string() });

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

/**
 * Map the shared service's {@link GitHubApiError} to the tRPC error surface the
 * router (and its clients) expect. The underlying fetch/link-header helpers live
 * in `../services/github`; these wrappers only translate the error shape so the
 * router's tRPC responses stay unchanged.
 */
function mapGitHubError(err: unknown): never {
  if (err instanceof GitHubApiError) {
    if (err.status === 401) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'GitHub token is invalid or expired',
      });
    }
    if (err.status === 403) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: err.apiMessage ?? 'GitHub rate limit exceeded or access denied',
      });
    }
    if (err.status === 404) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'GitHub resource not found',
      });
    }
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: err.apiMessage
        ? `GitHub API error ${err.status}: ${err.apiMessage}`
        : `GitHub API error: ${err.status}`,
    });
  }
  throw err;
}

/** Every procedure here needs a configured token; none can degrade without one. */
function requireGitHubToken(): string {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'GitHub token is not configured',
    });
  }
  return token;
}

async function githubFetchResponse(path: string, token?: string): Promise<Response> {
  try {
    return await serviceGithubFetchResponse(path, token);
  } catch (err) {
    mapGitHubError(err);
  }
}

async function githubFetch<T>(path: string, token?: string): Promise<T> {
  try {
    return await serviceGithubFetch<T>(path, token);
  } catch (err) {
    mapGitHubError(err);
  }
}

async function githubFetchAllPages<T>(
  path: string,
  itemSchema: z.ZodType<T>,
  token: string
): Promise<{ items: T[]; truncated: boolean }> {
  try {
    return await serviceGithubFetchAllPages(path, itemSchema, token);
  } catch (err) {
    mapGitHubError(err);
  }
}

export const githubRouter = router({
  /**
   * Every repo the token can reach (owned, collaborator, and org), most recently
   * updated first. The client searches this list itself: GitHub's search API
   * can't scope to "repos I can access" and skips forks by default.
   */
  listRepos: protectedProcedure.query(async () => {
    const token = requireGitHubToken();
    const { items, truncated } = await githubFetchAllPages(
      '/user/repos?sort=updated',
      repoSchema,
      token
    );

    // Pages are fetched in parallel, so a repo updated mid-walk can appear on two.
    const unique = [...new Map(items.map((r) => [r.id, r])).values()];

    return {
      repos: unique.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        name: r.name,
        owner: r.owner.login,
        description: r.description,
        private: r.private,
        defaultBranch: r.default_branch,
      })),
      truncated,
    };
  }),

  listBranches: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().regex(/^[\w-]+\/[\w.-]+$/),
      })
    )
    .query(async ({ input }) => {
      const token = requireGitHubToken();

      const [repo, { items, truncated }] = await Promise.all([
        githubFetch<GitHubRepo>(`/repos/${input.repoFullName}`, token),
        githubFetchAllPages(`/repos/${input.repoFullName}/branches`, branchSchema, token),
      ]);

      return {
        branches: defaultBranchFirst(
          items.map((b) => b.name),
          repo.default_branch
        ),
        defaultBranch: repo.default_branch,
        truncated,
      };
    }),

  listIssues: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().regex(/^[\w-]+\/[\w.-]+$/),
        search: z.string().optional(),
        state: z.enum(['open', 'closed', 'all']).default('open'),
        cursor: z.string().regex(/^\d+$/).optional(), // page number as string
        perPage: z.number().int().min(1).max(100).default(30),
      })
    )
    .query(async ({ input }) => {
      const token = requireGitHubToken();

      const page = input.cursor ? parseInt(input.cursor, 10) : 1;

      let issues: GitHubIssue[];
      let response: Response;

      if (input.search) {
        const query = encodeURIComponent(
          `${input.search} repo:${input.repoFullName} is:issue state:${input.state}`
        );
        const url = `/search/issues?q=${query}&per_page=${input.perPage}&page=${page}`;

        response = await githubFetchResponse(url, token);
        const data = await response.json();
        issues = data.items;
      } else {
        const url = `/repos/${input.repoFullName}/issues?state=${input.state}&per_page=${input.perPage}&page=${page}&sort=updated&direction=desc`;

        response = await githubFetchResponse(url, token);
        issues = await response.json();
      }

      // Filter out pull requests (GitHub returns them in issues endpoint)
      issues = issues.filter((issue) => !('pull_request' in issue));

      const links = parseLinkHeader(response.headers.get('link'));

      return {
        issues: issues.map((i) => ({
          id: i.id,
          number: i.number,
          title: i.title,
          body: i.body,
          state: i.state,
          author: i.user?.login || 'unknown',
          labels: i.labels.map((l) => ({ name: l.name, color: l.color })),
          comments: i.comments,
          createdAt: i.created_at,
          updatedAt: i.updated_at,
        })),
        nextCursor: links.next,
      };
    }),
});
