import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { TRPCError } from '@trpc/server';
import { env } from '@/lib/env';
import { defaultBranchFirst } from '@/lib/branch-list';
import type { Issue } from '@/lib/types';
import { repoFullNameSchema } from '@/lib/repo-full-name';
import {
  ConditionalGetCache,
  githubFetchResponse,
  githubFetchAllPages,
  parseGitHubResponse,
  parseLinkHeader,
  GitHubApiError,
  type ListPage,
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
const defaultBranchSchema = z.object({ default_branch: z.string() });

// The pickers refetch these every time they open. Zod strips unknown keys, so
// cached pages hold only the fields above, not GitHub's full objects.
const repoPageCache = new ConditionalGetCache<ListPage<GitHubRepo>>(10);
const branchPageCache = new ConditionalGetCache<ListPage<z.infer<typeof branchSchema>>>(200);
const defaultBranchCache = new ConditionalGetCache<string>(100);

// The issues endpoint lists pull requests too, marked by `pull_request`.
const issueSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  // Search results may omit `body`, and GitHub's spec lets a label's color be null.
  body: z
    .string()
    .nullish()
    .transform((body) => body ?? null),
  labels: z.array(
    z.object({
      name: z.string(),
      color: z
        .string()
        .nullable()
        .transform((color) => color ?? ''),
    })
  ),
  comments: z.number(),
  pull_request: z.unknown().optional(),
});
const issueListSchema = z.array(issueSchema);
const issueSearchSchema = z.object({ items: issueListSchema });

function toIssue(issue: z.infer<typeof issueSchema>): Issue {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    comments: issue.comments,
  };
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
      ctx.githubToken,
      repoPageCache
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
        repoFullName: repoFullNameSchema,
      })
    )
    .query(async ({ ctx, input }) => {
      const token = ctx.githubToken;
      const [defaultBranch, { items, truncated }] = await Promise.all([
        defaultBranchCache.fetch(
          `/repos/${input.repoFullName}`,
          token,
          async (response) =>
            (
              await parseGitHubResponse(
                response,
                defaultBranchSchema,
                `/repos/${input.repoFullName}`
              )
            ).default_branch
        ),
        githubFetchAllPages(
          `/repos/${input.repoFullName}/branches`,
          branchSchema,
          token,
          branchPageCache
        ),
      ]);

      return {
        branches: defaultBranchFirst(
          items.map((b) => b.name),
          defaultBranch
        ),
        defaultBranch,
        truncated,
      };
    }),

  listIssues: githubProcedure
    .input(
      z.object({
        repoFullName: repoFullNameSchema,
        search: z.string().optional(),
        cursor: z.string().regex(/^\d+$/).optional(), // page number as string
        perPage: z.number().int().min(1).max(100).default(30),
      })
    )
    .query(async ({ ctx, input }) => {
      const token = ctx.githubToken;
      const page = input.cursor ? parseInt(input.cursor, 10) : 1;

      let issues: z.infer<typeof issueListSchema>;
      let response: Response;

      if (input.search) {
        const query = encodeURIComponent(
          `${input.search} repo:${input.repoFullName} is:issue state:open`
        );
        const url = `/search/issues?q=${query}&per_page=${input.perPage}&page=${page}`;

        response = await githubFetchResponse(url, token);
        issues = (await parseGitHubResponse(response, issueSearchSchema, url)).items;
      } else {
        const url = `/repos/${input.repoFullName}/issues?state=open&per_page=${input.perPage}&page=${page}&sort=updated&direction=desc`;

        response = await githubFetchResponse(url, token);
        issues = await parseGitHubResponse(response, issueListSchema, url);
      }

      const links = parseLinkHeader(response.headers.get('link'));

      return {
        issues: issues.filter((issue) => issue.pull_request === undefined).map(toIssue),
        nextCursor: links.next,
      };
    }),
});
