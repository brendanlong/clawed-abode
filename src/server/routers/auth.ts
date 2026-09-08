import { z } from 'zod';
import { router, publicProcedure, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { verifyPassword, loginSchema, IDLE_TIMEOUT_MS } from '@/lib/auth';
import { loginRateLimiter } from '@/lib/rate-limiter';
import { env } from '@/lib/env';
import { TRPCError } from '@trpc/server';
import { createLogger, toError } from '@/lib/logger';
import {
  DEFAULT_PAGE_SIZE,
  buildKeysetWhere,
  keysetCursorSchema,
  sliceKeysetPage,
} from '@/lib/keyset-page';
import { createAuthSession, purgeInactiveAuthSessions } from '../services/auth-sessions';

const log = createLogger('auth');

export const authRouter = router({
  login: publicProcedure.input(loginSchema).mutation(async ({ input, ctx }) => {
    // IP and user agent come from request headers (never from client input, which
    // an attacker could vary to dodge the rate limiter).
    const rateLimitKey = ctx.ipAddress ?? 'unknown';
    const rateLimitCheck = loginRateLimiter.check(rateLimitKey);

    if (!rateLimitCheck.allowed) {
      const retryAfterMinutes = Math.ceil((rateLimitCheck.retryAfterMs ?? 0) / 60000);
      log.warn('Login rate limited', { ip: ctx.ipAddress, retryAfterMinutes });
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `Too many login attempts. Please try again in ${retryAfterMinutes} minute${retryAfterMinutes === 1 ? '' : 's'}.`,
      });
    }

    // Check if password hash is configured
    if (!env.PASSWORD_HASH) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Authentication not configured. Set PASSWORD_HASH environment variable.',
      });
    }

    let valid: boolean;
    try {
      valid = await verifyPassword(input.password, env.PASSWORD_HASH);
    } catch (error) {
      log.error('Password verification error', toError(error));
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Invalid PASSWORD_HASH format. Generate with: pnpm hash-password <yourpassword>',
      });
    }

    if (!valid) {
      // Record failed attempt for rate limiting
      const failureResult = loginRateLimiter.recordFailure(rateLimitKey);
      log.warn('Failed login attempt', {
        ip: ctx.ipAddress,
        remainingAttempts: failureResult.remainingAttempts,
      });
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Invalid password',
      });
    }

    // Record successful login (resets attempt counter)
    loginRateLimiter.recordSuccess(rateLimitKey);

    try {
      await purgeInactiveAuthSessions();
    } catch (error) {
      log.error('Failed to purge inactive auth sessions', toError(error));
    }

    const token = await createAuthSession(ctx.ipAddress, ctx.userAgent);

    return { token };
  }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    // Revoke the current session instead of deleting
    await prisma.authSession.update({
      where: { id: ctx.sessionId },
      data: { revokedAt: new Date() },
    });

    return { success: true };
  }),

  // Keyset-paginated by (createdAt desc, id desc); inactive sessions are included
  // for audit until purgeInactiveAuthSessions deletes them.
  listSessions: protectedProcedure
    .input(
      z.object({
        cursor: keysetCursorSchema.optional(),
        limit: z.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
      })
    )
    .query(async ({ input, ctx }) => {
      const rows = await prisma.authSession.findMany({
        where: buildKeysetWhere('createdAt', input.cursor),
        select: {
          id: true,
          createdAt: true,
          expiresAt: true,
          lastActivityAt: true,
          revokedAt: true,
          ipAddress: true,
          userAgent: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
      });
      const { items, nextCursor } = sliceKeysetPage(rows, input.limit, 'createdAt');

      return {
        sessions: items.map((s) => {
          const idleExpiresAt = new Date(s.lastActivityAt.getTime() + IDLE_TIMEOUT_MS);
          const effectiveExpiresAt = idleExpiresAt < s.expiresAt ? idleExpiresAt : s.expiresAt;
          return {
            ...s,
            effectiveExpiresAt,
            isCurrent: s.id === ctx.sessionId,
          };
        }),
        nextCursor,
      };
    }),

  deleteSession: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Prevent revoking current session via this endpoint
      if (input.sessionId === ctx.sessionId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Use logout to revoke your current session',
        });
      }

      // Revoke the session instead of deleting
      await prisma.authSession.update({
        where: { id: input.sessionId },
        data: { revokedAt: new Date() },
      });

      return { success: true };
    }),
});
