import { z } from 'zod';
import { router, publicProcedure, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { loginSchema, effectiveExpiry } from '@/lib/auth';
import { env } from '@/lib/env';
import { TRPCError } from '@trpc/server';
import { keysetPage, keysetPageInputSchema } from '@/lib/keyset-page';
import { loginWithPassword, retryAfterMessage } from '../services/password-login';
import { mintPublicLoginCode } from '../services/public-login-codes';

export const authRouter = router({
  login: publicProcedure.input(loginSchema).mutation(async ({ input, ctx }) => {
    const result = await loginWithPassword(input.password, ctx);
    if (result.ok) return { token: result.token };
    switch (result.reason) {
      case 'rate_limited':
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: retryAfterMessage(result.retryAfterMs),
        });
      case 'invalid_password':
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid password' });
      case 'not_configured':
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Authentication not configured. Set PASSWORD_HASH environment variable.',
        });
      case 'bad_hash':
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Invalid PASSWORD_HASH format. Generate with: pnpm hash-password <yourpassword>',
        });
    }
  }),

  publicFilesUrl: protectedProcedure.query(() => ({ url: env.PUBLIC_FILES_URL ?? null })),

  /**
   * A one-time code that signs whichever browser opens a public-files link into
   * that server. The PWA can't hand its cookie to the browser Android opens links
   * in, but it can put this in the URL.
   */
  createPublicLoginCode: protectedProcedure.mutation(() => {
    if (!env.PUBLIC_FILES_URL) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Public files are not configured' });
    }
    return { code: mintPublicLoginCode() };
  }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    await prisma.authSession.update({
      where: { id: ctx.sessionId },
      data: { revokedAt: new Date() },
    });

    return { success: true };
  }),

  // Keyset-paginated by (createdAt desc, id desc); inactive sessions are included
  // for audit until purgeInactiveAuthSessions deletes them.
  listSessions: protectedProcedure.input(keysetPageInputSchema).query(async ({ input, ctx }) => {
    const page = keysetPage('createdAt', input);
    const rows = await prisma.authSession.findMany({
      where: page.where,
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        lastActivityAt: true,
        revokedAt: true,
        ipAddress: true,
        userAgent: true,
      },
      orderBy: page.orderBy,
      take: page.take,
    });
    const { items, nextCursor } = page.slice(rows);

    return {
      sessions: items.map((s) => ({
        ...s,
        effectiveExpiresAt: effectiveExpiry(s),
        isCurrent: s.id === ctx.sessionId,
      })),
      nextCursor,
    };
  }),

  deleteSession: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      // Prevent revoking current session via this endpoint
      if (input.sessionId === ctx.sessionId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Use logout to revoke your current session',
        });
      }

      // updateMany, not update, so a missing row reports NOT_FOUND instead of
      // throwing Prisma's P2025 as a 500.
      const { count } = await prisma.authSession.updateMany({
        where: { id: input.sessionId },
        data: { revokedAt: new Date() },
      });

      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
      }

      return { success: true };
    }),
});
