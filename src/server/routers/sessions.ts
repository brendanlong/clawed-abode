import { z } from 'zod';
import { router, protectedProcedure, sessionProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { getSessionWorkspacePath } from '../services/worktree-manager';
import { buildEditorUrl } from '@/lib/editor-url';
import { isClaudeRunning, isSessionBackgroundActive } from '../services/claude-runner';
import { isSessionRateLimitPaused, recomputeRateLimitHolds } from '../services/rate-limit-pause';
import {
  archiveSession,
  createSession,
  setSessionModel,
  shutDownSession,
  startSession,
  updateSession,
} from '../services/session-lifecycle';
import { env } from '@/lib/env';
import { sessionNameSchema } from '@/lib/session-name';
import { PROMPT_MAX_LENGTH } from '@/lib/types';
import { toSessionView } from '@/lib/session-view';
import type { Prisma } from '@/generated/prisma/client';
import { keysetPage, keysetPageInputSchema } from '@/lib/keyset-page';
import { sessionStatusSchema } from '@/lib/session-display-status';
import { thresholdSchema } from '@/lib/rate-limit';
import { repoFullNameSchema } from '@/lib/repo-full-name';
import { refreshStalePullRequests } from '../services/session-branch-pr';

const sessionListSelect = {
  id: true,
  name: true,
  repoUrl: true,
  branch: true,
  status: true,
  statusMessage: true,
  currentBranch: true,
  pullRequest: true,
  prCheckedAt: true, // server-only; toSessionView drops it before the client sees it
  lastActivityAt: true,
  createdAt: true,
} satisfies Prisma.SessionSelect;

export const sessionsRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        name: sessionNameSchema,
        repoFullName: repoFullNameSchema.optional(),
        branch: z.string().min(1).optional(),
        initialPrompt: z.string().max(PROMPT_MAX_LENGTH).optional(),
        claudeModel: z.string().max(200).optional(),
      })
    )
    .mutation(async ({ input }) => ({ session: toSessionView(await createSession(input)) })),

  // Keyset-paginated by (lastActivityAt desc, id desc). Archived sessions are
  // excluded unless `status: 'archived'` is requested explicitly, so the home page
  // fetches the active and archived lists as two independent paginated queries.
  list: protectedProcedure
    .input(keysetPageInputSchema.extend({ status: sessionStatusSchema.optional() }))
    .query(async ({ input }) => {
      const page = keysetPage('lastActivityAt', input);
      const rows = await prisma.session.findMany({
        where: {
          ...(input.status ? { status: input.status } : { status: { not: 'archived' } }),
          ...page.where,
        },
        orderBy: page.orderBy,
        take: page.take,
        select: sessionListSelect,
      });
      const { items, nextCursor } = page.slice(rows);

      // Attach the live status axes (in-memory lookups, no extra query) so the
      // list can distinguish "running" (main agent generating) from "background"
      // (only a subagent/background task running) from "waiting" (fully idle).
      const sessions = items.map((session) => ({
        ...toSessionView(session),
        turnActive: isClaudeRunning(session.id),
        backgroundActive: isSessionBackgroundActive(session.id),
        rateLimitPaused: isSessionRateLimitPaused(session.id),
      }));

      refreshStalePullRequests(items);

      return { sessions, nextCursor };
    }),

  get: sessionProcedure.query(({ ctx }) => {
    refreshStalePullRequests([ctx.session]);
    return { session: toSessionView(ctx.session) };
  }),

  // Resolves the sender of a message from another session. Archived sessions
  // are included: their transcripts are still viewable.
  byAgentName: protectedProcedure
    .input(z.object({ agentName: z.string().min(1).max(200) }))
    .query(async ({ input }) => ({
      session: await prisma.session.findFirst({
        where: { agentName: input.agentName },
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true },
      }),
    })),

  // Deep link into a self-hosted code-server (browser VS Code) instance opened
  // on this session's worktree folder. Returns { url: null } when the editor is
  // not configured (CODE_SERVER_URL unset) or the session has no workspace on
  // disk (archived), so the UI can hide the button.
  getEditorUrl: sessionProcedure.query(({ ctx }) => {
    const { session } = ctx;

    // Archived sessions have their workspace removed from disk.
    if (session.status === 'archived') {
      return { url: null };
    }

    // Open the session's workspace root (not just the repo checkout) so the
    // operator sees all of the session's files — the repo clone alongside the
    // uploads/ sibling folder.
    const workspaceDir = getSessionWorkspacePath(session.id);
    return { url: buildEditorUrl(env.CODE_SERVER_URL, workspaceDir) };
  }),

  start: sessionProcedure.mutation(async ({ input }) => ({
    session: toSessionView(await startSession(input.sessionId)),
  })),

  rename: sessionProcedure
    .input(z.object({ name: sessionNameSchema }))
    .mutation(async ({ input }) => {
      // Renaming only changes the display name; the session id and workspace
      // are untouched. lastActivityAt is deliberately not bumped so renaming
      // doesn't reorder the session list.
      const session = await updateSession(input.sessionId, { name: input.name });
      return { session: toSessionView(session) };
    }),

  /**
   * Per-session rate-limit pause overrides; null on either field inherits the
   * global default (see resolvePausePolicy). Recomputes holds immediately so a
   * lowered threshold parks work now rather than at the next reading.
   */
  setRateLimitPause: sessionProcedure
    .input(
      z.object({
        enabled: z.boolean().nullable(),
        threshold: thresholdSchema.nullable(),
      })
    )
    .mutation(async ({ input }) => {
      const session = await updateSession(input.sessionId, {
        rateLimitPauseEnabled: input.enabled,
        rateLimitPauseThreshold: input.threshold,
      });
      await recomputeRateLimitHolds();
      return { session: toSessionView(session) };
    }),

  setModel: sessionProcedure
    .input(z.object({ claudeModel: z.string().max(200).nullable() }))
    .mutation(async ({ input }) => {
      const model = input.claudeModel?.trim() || null;
      return { session: toSessionView(await setSessionModel(input.sessionId, model)) };
    }),

  stop: sessionProcedure.mutation(async ({ input }) => ({
    session: toSessionView(await shutDownSession(input.sessionId)),
  })),

  delete: sessionProcedure.mutation(async ({ input }) => {
    await archiveSession(input.sessionId);
    return { success: true };
  }),
});
