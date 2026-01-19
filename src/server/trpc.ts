import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { parseAuthHeader } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export interface AuthUser {
  userId: string;
  username: string;
}

export interface Context {
  user: AuthUser | null;
}

export async function createContext(opts: { headers: Headers }): Promise<Context> {
  const authHeader = opts.headers.get('authorization');
  const token = parseAuthHeader(authHeader);

  if (!token) {
    return { user: null };
  }

  const session = await prisma.authSession.findUnique({
    where: { token },
    include: { user: { select: { id: true, username: true } } },
  });

  if (!session || session.expiresAt < new Date()) {
    return { user: null };
  }

  return {
    user: {
      userId: session.user.id,
      username: session.user.username,
    },
  };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource',
    });
  }
  return next({
    ctx: {
      user: ctx.user,
    },
  });
});
