import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { TRPCError } from '@trpc/server';
import { env } from '@/lib/env';
import { defaultBranchFirst } from '@/lib/branch-list';
import {
  githubFetch,
  githubFetchResponse,
  githubFetchAllPages,
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
  labels: Array<{ name: string; color: string }>;
  comments: number;
}

/** Map the shared service's {@link GitHubApiError} to the router's tRPC error surface. */
function toTRPCError(err: GitHubApiError): TRPCError {
  if (err.status === 401) {
    return new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'GitHub token is invalid or expired',
    });
  }
  if (err.status === 403) {
    return new TRPCError({
      code: 'FORBIDDEN',
      message: err.apiMessage ?? 'GitHub rate limit exceeded or access denied',
    });
  }
  if (err.status === 404) {
    return new TRPCError({ code: 'NOT_FOUND', message: 'GitHub resource not found' });
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: err.apiMessage
      ? `GitHub API error ${err.status}: ${err.apiMessage}`
      : `GitHub API error: ${err.status}`,
  });
}

/**
 * Every procedure here needs a configured token (none can degrade without one),
 * and surfaces GitHub API failures as tRPC errors.
 */
const githubProcedure = protectedProcedure.use(async ({ next }) => {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'GitHub token is not configured' });
  }
  const result = await next({ ctx: { githubToken: token } });
  if (!result.ok && result.error.cause instanceof GitHubApiError) {
    throw toTRPCError(result.error.cause);
  }
  return result;
});

export const githubRouter = router({
  /**
   * Every repo the token can reach (owned, collaborator, and org), most recently
   * updated first. The client searches this list itself: GitHub's search API
   * can't scope to "repos I can access" and skips forks by default.
   */
  listRepos: githubProcedure.query(async ({ ctx }) => {
    const { items, truncated } = await githubFetchAllPages(
      '/user/repos?sort=updated',
      repoSchema,
      ctx.githubToken
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

  listBranches: githubProcedure
    .input(
      z.object({
        repoFullName: z.string().regex(/^[\w-]+\/[\w.-]+$/),
      })
    )
    .query(async ({ ctx, input }) => {
      const token = ctx.githubToken;
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

  listIssues: githubProcedure
    .input(
      z.object({
        repoFullName: z.string().regex(/^[\w-]+\/[\w.-]+$/),
        search: z.string().optional(),
        cursor: z.string().regex(/^\d+$/).optional(), // page number as string
        perPage: z.number().int().min(1).max(100).default(30),
      })
    )
    .query(async ({ ctx, input }) => {
      const token = ctx.githubToken;
      const page = input.cursor ? parseInt(input.cursor, 10) : 1;

      let issues: GitHubIssue[];
      let response: Response;

      if (input.search) {
        const query = encodeURIComponent(
          `${input.search} repo:${input.repoFullName} is:issue state:open`
        );
        const url = `/search/issues?q=${query}&per_page=${input.perPage}&page=${page}`;

        response = await githubFetchResponse(url, token);
        const data = await response.json();
        issues = data.items;
      } else {
        const url = `/repos/${input.repoFullName}/issues?state=open&per_page=${input.perPage}&page=${page}&sort=updated&direction=desc`;

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
          labels: i.labels.map((l) => ({ name: l.name, color: l.color })),
          comments: i.comments,
        })),
        nextCursor: links.next,
      };
    }),
});
