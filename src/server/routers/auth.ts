import { z } from 'zod';
import { router, publicProcedure, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  loginSchema,
  SESSION_DURATION_MS,
} from '@/lib/auth';
import { TRPCError } from '@trpc/server';

async function createAuthSession(userId: string): Promise<string> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await prisma.authSession.create({
    data: {
      token,
      userId,
      expiresAt,
    },
  });

  return token;
}

export const authRouter = router({
  login: publicProcedure.input(loginSchema).mutation(async ({ input }) => {
    const user = await prisma.user.findUnique({
      where: { username: input.username },
    });

    if (!user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Invalid username or password',
      });
    }

    const valid = await verifyPassword(input.password, user.passwordHash);

    if (!valid) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Invalid username or password',
      });
    }

    const token = await createAuthSession(user.id);

    return { token, user: { id: user.id, username: user.username } };
  }),

  register: publicProcedure
    .input(
      z.object({
        username: z.string().min(3).max(32),
        password: z.string().min(8).max(128),
      })
    )
    .mutation(async ({ input }) => {
      // Check if any users exist - only allow registration if no users exist
      const userCount = await prisma.user.count();
      if (userCount > 0) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Registration is disabled. Contact the administrator.',
        });
      }

      const existing = await prisma.user.findUnique({
        where: { username: input.username },
      });

      if (existing) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Username already taken',
        });
      }

      const passwordHash = await hashPassword(input.password);

      const user = await prisma.user.create({
        data: {
          username: input.username,
          passwordHash,
        },
      });

      const token = await createAuthSession(user.id);

      return { token, user: { id: user.id, username: user.username } };
    }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    // Delete all sessions for this user (logs out everywhere)
    await prisma.authSession.deleteMany({
      where: { userId: ctx.user.userId },
    });

    return { success: true };
  }),

  me: protectedProcedure.query(async ({ ctx }) => {
    const user = await prisma.user.findUnique({
      where: { id: ctx.user.userId },
      select: { id: true, username: true },
    });

    if (!user) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'User not found',
      });
    }

    return user;
  }),

  needsSetup: publicProcedure.query(async () => {
    const userCount = await prisma.user.count();
    return { needsSetup: userCount === 0 };
  }),
});
