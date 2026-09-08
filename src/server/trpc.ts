import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { z } from 'zod';
import { parseAuthHeader, IDLE_TIMEOUT_MS, ACTIVITY_UPDATE_THROTTLE_MS } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';

const log = createLogger('trpc');

export interface Context {
  sessionId: string | null;
  /** Client IP and user agent, derived from request headers for login rate limiting and the auth-session audit list. */
  ipAddress?: string;
  userAgent?: string;
}

/** Tailscale Serve/Funnel and other reverse proxies put the real client IP first in X-Forwarded-For. */
export function getClientIp(headers: Headers): string | undefined {
  const forwarded = headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || headers.get('x-real-ip')?.trim() || undefined;
}

export async function createContext(opts: { headers: Headers }): Promise<Context> {
  const clientInfo = {
    ipAddress: getClientIp(opts.headers),
    userAgent: opts.headers.get('user-agent') ?? undefined,
  };
  const authHeader = opts.headers.get('authorization');
  const token = parseAuthHeader(authHeader);

  if (!token) {
    return { sessionId: null, ...clientInfo };
  }

  const session = await prisma.authSession.findUnique({
    where: { token },
    select: { id: true, expiresAt: true, lastActivityAt: true, revokedAt: true },
  });

  if (!session) {
    return { sessionId: null, ...clientInfo };
  }

  const now = new Date();

  // Check if session has been revoked
  if (session.revokedAt) {
    return { sessionId: null, ...clientInfo };
  }

  // Check if session has expired
  if (session.expiresAt < now) {
    return { sessionId: null, ...clientInfo };
  }

  // Check for idle timeout
  const idleTime = now.getTime() - session.lastActivityAt.getTime();
  if (idleTime > IDLE_TIMEOUT_MS) {
    // Session is idle, reject it (but don't delete - keep for audit/display)
    log.info('Session rejected due to idle timeout', { sessionId: session.id });
    return { sessionId: null, ...clientInfo };
  }

  // Update last activity (throttled to avoid excessive DB writes)
  if (idleTime > ACTIVITY_UPDATE_THROTTLE_MS) {
    prisma.authSession
      .update({
        where: { id: session.id },
        data: { lastActivityAt: now },
      })
      .catch(() => {
        // Fire and forget - don't fail the request if activity update fails
      });
  }

  return { sessionId: session.id, ...clientInfo };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  sse: {
    ping: {
      enabled: true,
      intervalMs: 2000,
    },
    client: {
      reconnectAfterInactivityMs: 5000,
    },
  },
});

// Failures are warnings; mutations are user actions worth an info line; queries
// and subscriptions are mostly polls and stay at debug so they don't flood journald.
const loggingMiddleware = t.middleware(async ({ path, type, next }) => {
  const start = Date.now();
  const result = await next();
  const duration = Date.now() - start;

  if (!result.ok) {
    log.warn(`${type} ${path} failed`, { duration, error: result.error.message });
  } else if (type === 'mutation') {
    log.info(`${type} ${path}`, { duration });
  } else {
    log.debug(`${type} ${path}`, { duration });
  }

  return result;
});

// Base procedure with logging
const baseProcedure = t.procedure.use(loggingMiddleware);

export const router = t.router;
export const publicProcedure = baseProcedure;

export const protectedProcedure = baseProcedure.use(({ ctx, next }) => {
  if (!ctx.sessionId) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource',
    });
  }
  return next({
    ctx: {
      sessionId: ctx.sessionId,
    },
  });
});

/**
 * A protected procedure over one Claude session. Takes `{ sessionId }`, loads
 * the row into `ctx.session`, and throws NOT_FOUND when it doesn't exist.
 * Procedures needing more input add a second `.input()`; tRPC merges the objects.
 */
export const sessionProcedure = protectedProcedure
  .input(z.object({ sessionId: z.string().uuid() }))
  .use(async ({ input, next }) => {
    const session = await prisma.session.findUnique({ where: { id: input.sessionId } });
    if (!session) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
    }
    return next({ ctx: { session } });
  });

/** `sessionProcedure` that also requires a `running` session (one with a live query to talk to). */
export const runningSessionProcedure = sessionProcedure.use(({ ctx, next }) => {
  if (ctx.session.status !== 'running') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Session is not running' });
  }
  return next();
});
