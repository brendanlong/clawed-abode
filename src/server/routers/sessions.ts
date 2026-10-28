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
  configureSession,
  setSessionStarred,
  shutDownSession,
  startSession,
  updateSession,
} from '../services/session-lifecycle';
import { env } from '@/lib/env';
import { sessionNameSchema } from '@/lib/session-name';
import { PROMPT_MAX_LENGTH, SESSION_SEARCH_MAX_LENGTH } from '@/lib/types';
import { toSessionView } from '@/lib/session-view';
import { storedNamesSchema } from '@/lib/attachments';
import type { Prisma } from '@/generated/prisma/client';
import { pinnedKeysetPage, pinnedKeysetPageInputSchema } from '@/lib/keyset-page';
import { sessionStatusSchema } from '@/lib/session-display-status';
import { thresholdSchema } from '@/lib/rate-limit';
import { repoFullNameSchema } from '@/lib/repo-full-name';
import { refreshStalePullRequests } from '../services/session-branch-pr';
import { clearAttention } from '../services/session-attention';
import { modelSchema, nullableModelSchema } from '../services/settings-helpers';
import { getWorkspaceDiskUsage } from '../services/disk-usage';

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
  starred: true,
  attentionAt: true,
  attentionSummary: true,
  createdAt: true,
} satisfies Prisma.SessionSelect;

export const sessionsRouter = router({
  diskUsage: protectedProcedure.query(() => getWorkspaceDiskUsage()),

  create: protectedProcedure
    .input(
      z.object({
        name: sessionNameSchema,
        repoFullName: repoFullNameSchema.optional(),
        branch: z.string().min(1).optional(),
        initialPrompt: z.string().max(PROMPT_MAX_LENGTH).optional(),
        // Staged uploads (see /api/upload) sent along with the initial prompt.
        initialAttachments: storedNamesSchema.optional(),
        claudeModel: modelSchema.optional(),
        sessionToolsEnabled: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => ({ session: toSessionView(await createSession(input)) })),

  // Keyset-paginated by (starred desc, lastActivityAt desc, id desc). Archived sessions are
  // excluded unless `status: 'archived'` is requested explicitly, so the home page
  // fetches the active and archived lists as two independent paginated queries.
  // `search` is a case-insensitive substring match on name, repo, and branch.
  list: protectedProcedure
    .input(
      pinnedKeysetPageInputSchema.extend({
        status: sessionStatusSchema.optional(),
        search: z.string().trim().max(SESSION_SEARCH_MAX_LENGTH).optional(),
      })
    )
    .query(async ({ input }) => {
      const page = pinnedKeysetPage('starred', 'lastActivityAt', input);
      const rows = await prisma.session.findMany({
        where: {
          AND: [
            input.status ? { status: input.status } : { status: { not: 'archived' } },
            page.where,
            input.search
              ? {
                  OR: [
                    { name: { contains: input.search } },
                    { repoUrl: { contains: input.search } },
                    { currentBranch: { contains: input.search } },
                  ],
                }
              : {},
          ],
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

  // Session-changing mutations return nothing: the change reaches clients on the
  // session stream.
  start: sessionProcedure.mutation(async ({ input }) => {
    await startSession(input.sessionId);
  }),

  rename: sessionProcedure
    .input(z.object({ name: sessionNameSchema }))
    .mutation(async ({ input }) => {
      // Renaming only changes the display name; the session id and workspace
      // are untouched. lastActivityAt is deliberately not bumped so renaming
      // doesn't reorder the session list.
      await updateSession(input.sessionId, { name: input.name });
    }),

  /**
   * Per-session rate-limit pause overrides; null on either field inherits the
   * global default (see resolvePausePolicy). Recomputes holds immediately so a
   * lowered threshold parks work now rather than at the next reading.
   */
  setStarred: sessionProcedure
    .input(z.object({ starred: z.boolean() }))
    .mutation(async ({ input }) => {
      await setSessionStarred(input.sessionId, input.starred);
    }),

  setRateLimitPause: sessionProcedure
    .input(
      z.object({
        enabled: z.boolean().nullable(),
        threshold: thresholdSchema.nullable(),
      })
    )
    .mutation(async ({ input }) => {
      await updateSession(input.sessionId, {
        rateLimitPauseEnabled: input.enabled,
        rateLimitPauseThreshold: input.threshold,
      });
      await recomputeRateLimitHolds();
    }),

  // The session page calls this while it is on screen, so an agent's request for
  // the user is cleared once seen rather than only once answered.
  markSeen: sessionProcedure.mutation(async ({ input }) => {
    await clearAttention(input.sessionId);
    return { success: true };
  }),

  setModel: sessionProcedure
    .input(z.object({ claudeModel: nullableModelSchema }))
    .mutation(async ({ input }) => {
      await configureSession(input.sessionId, { claudeModel: input.claudeModel });
    }),

  /** Takes effect by restarting the session's query once it's idle (see applyLiveSettings). */
  setSessionTools: sessionProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await configureSession(input.sessionId, { sessionToolsEnabled: input.enabled });
    }),

  stop: sessionProcedure.mutation(async ({ input }) => {
    await shutDownSession(input.sessionId);
  }),

  delete: sessionProcedure.mutation(async ({ input }) => {
    await archiveSession(input.sessionId);
    return { success: true };
  }),
});
