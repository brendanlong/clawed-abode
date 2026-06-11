import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { TRPCError } from '@trpc/server';
import { env } from '@/lib/env';
import { prisma } from '@/lib/prisma';
import { extractRepoFullName } from '@/lib/utils';
import {
  fetchPullRequestForBranch,
  listRepos,
  listBranches,
  listIssues,
  getIssue,
  GitHubApiError,
} from '../services/github';

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

/**
 * Convert GitHubApiError from the service layer into the TRPCError the
 * frontend expects.
 */
function toTRPCError(error: unknown): never {
  if (error instanceof GitHubApiError) {
    if (error.status === 401) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'GitHub token is invalid or expired',
      });
    }
    if (error.status === 403) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'GitHub rate limit exceeded or access denied',
      });
    }
    if (error.status === 404) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'GitHub resource not found',
      });
    }
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `GitHub API error: ${error.status}`,
    });
  }
  throw error;
}

export const githubRouter = router({
  listRepos: protectedProcedure
    .input(
      z.object({
        search: z.string().optional(),
        cursor: z.string().optional(), // page number as string
        perPage: z.number().int().min(1).max(100).default(30),
      })
    )
    .query(async ({ input }) => {
      const token = requireGitHubToken();

      try {
        const result = await listRepos(
          {
            search: input.search,
            page: input.cursor ? parseInt(input.cursor, 10) : 1,
            perPage: input.perPage,
          },
          token
        );
        return {
          repos: result.repos,
          nextCursor: result.nextPage?.toString(),
        };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  listBranches: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().regex(/^[\w-]+\/[\w.-]+$/),
      })
    )
    .query(async ({ input }) => {
      const token = requireGitHubToken();

      try {
        return await listBranches(input.repoFullName, token);
      } catch (error) {
        toTRPCError(error);
      }
    }),

  listIssues: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().regex(/^[\w-]+\/[\w.-]+$/),
        search: z.string().optional(),
        state: z.enum(['open', 'closed', 'all']).default('open'),
        cursor: z.string().optional(), // page number as string
        perPage: z.number().int().min(1).max(100).default(30),
      })
    )
    .query(async ({ input }) => {
      const token = requireGitHubToken();

      try {
        const result = await listIssues(
          {
            repoFullName: input.repoFullName,
            search: input.search,
            state: input.state,
            page: input.cursor ? parseInt(input.cursor, 10) : 1,
            perPage: input.perPage,
          },
          token
        );
        return {
          issues: result.issues,
          nextCursor: result.nextPage?.toString(),
        };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  getIssue: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().regex(/^[\w-]+\/[\w.-]+$/),
        issueNumber: z.number().int().positive(),
      })
    )
    .query(async ({ input }) => {
      const token = requireGitHubToken();

      try {
        return { issue: await getIssue(input.repoFullName, input.issueNumber, token) };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  getSessionPrStatus: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      const session = await prisma.session.findUnique({
        where: { id: input.sessionId },
        select: { repoUrl: true, currentBranch: true },
      });

      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found',
        });
      }

      if (!session.currentBranch || !session.repoUrl) {
        return { pullRequest: null };
      }

      const repoFullName = extractRepoFullName(session.repoUrl);
      const pullRequest = await fetchPullRequestForBranch(repoFullName, session.currentBranch);
      return { pullRequest: pullRequest ?? null };
    }),
});
