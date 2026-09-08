import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { z } from 'zod';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { createTestSession } from '@/test/fixtures';
import { IDLE_TIMEOUT_MS, ACTIVITY_UPDATE_THROTTLE_MS, generateSessionToken } from '@/lib/auth';

vi.mock('@/lib/logger', async () => (await import('@/test/mock-logger')).mockLoggerModule());

// Set in beforeAll after the test DB is set up (the trpc module imports prisma)
let trpc: typeof import('./trpc');
let createContext: (typeof import('./trpc'))['createContext'];

beforeAll(async () => {
  await setupTestDb();
  trpc = await import('./trpc');
  createContext = trpc.createContext;
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearTestDb();
});

describe('createContext - activity tracking', () => {
  function createHeaders(token: string | null): Headers {
    const headers = new Headers();
    if (token) {
      headers.set('authorization', `Bearer ${token}`);
    }
    return headers;
  }

  async function createTestSession(
    overrides: {
      lastActivityAt?: Date;
      expiresAt?: Date;
    } = {}
  ) {
    const token = generateSessionToken();
    const now = new Date();
    const session = await testPrisma.authSession.create({
      data: {
        token,
        expiresAt: overrides.expiresAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), // 7 days
        lastActivityAt: overrides.lastActivityAt ?? now,
      },
    });
    return { session, token };
  }

  describe('client info', () => {
    it('prefers the first X-Forwarded-For hop, then X-Real-IP, and passes through the user agent', async () => {
      const headers = createHeaders(null);
      headers.set('x-forwarded-for', '100.64.0.7, 10.0.0.1');
      headers.set('x-real-ip', '10.0.0.2');
      headers.set('user-agent', 'test-agent');
      const ctx = await createContext({ headers });
      expect(ctx).toEqual({
        sessionId: null,
        appOrigin: null,
        ipAddress: '100.64.0.7',
        userAgent: 'test-agent',
      });

      headers.delete('x-forwarded-for');
      expect((await createContext({ headers })).ipAddress).toBe('10.0.0.2');

      headers.delete('x-real-ip');
      expect((await createContext({ headers })).ipAddress).toBeUndefined();
    });
  });

  describe('session validation', () => {
    it('should return null sessionId for missing token', async () => {
      const ctx = await createContext({ headers: createHeaders(null) });
      expect(ctx.sessionId).toBeNull();
    });

    it('should return null sessionId for invalid token', async () => {
      const ctx = await createContext({ headers: createHeaders('invalid-token') });
      expect(ctx.sessionId).toBeNull();
    });

    it('should return sessionId for valid token', async () => {
      const { session, token } = await createTestSession();

      const ctx = await createContext({ headers: createHeaders(token) });
      expect(ctx.sessionId).toBe(session.id);
    });
  });

  describe('expiration', () => {
    it('should reject expired sessions but preserve them in database', async () => {
      const expiredDate = new Date(Date.now() - 1000); // 1 second ago
      const { session, token } = await createTestSession({ expiresAt: expiredDate });

      const ctx = await createContext({ headers: createHeaders(token) });
      expect(ctx.sessionId).toBeNull();

      // Session should be preserved (not deleted) for audit/display purposes
      const remaining = await testPrisma.authSession.findFirst({
        where: { id: session.id },
      });
      expect(remaining).not.toBeNull();
    });
  });

  describe('idle timeout', () => {
    it('should accept sessions within idle timeout', async () => {
      const lastActivity = new Date(Date.now() - IDLE_TIMEOUT_MS / 2); // Half of idle timeout ago
      const { session, token } = await createTestSession({ lastActivityAt: lastActivity });

      const ctx = await createContext({ headers: createHeaders(token) });
      expect(ctx.sessionId).toBe(session.id);
    });

    it('should reject sessions exceeding idle timeout but preserve them in database', async () => {
      const lastActivity = new Date(Date.now() - IDLE_TIMEOUT_MS - 1000); // Past idle timeout
      const { session, token } = await createTestSession({ lastActivityAt: lastActivity });

      const ctx = await createContext({ headers: createHeaders(token) });
      expect(ctx.sessionId).toBeNull();

      // Session should be preserved (not deleted) for audit/display purposes
      const remaining = await testPrisma.authSession.findFirst({
        where: { id: session.id },
      });
      expect(remaining).not.toBeNull();
    });
  });

  describe('activity update throttling', () => {
    it('should update activity when exceeding throttle interval', async () => {
      const lastActivity = new Date(Date.now() - ACTIVITY_UPDATE_THROTTLE_MS - 1000);
      const { session, token } = await createTestSession({ lastActivityAt: lastActivity });

      const ctx = await createContext({ headers: createHeaders(token) });

      // Session should be valid
      expect(ctx.sessionId).toBe(session.id);

      // Wait a bit for the async update to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Last activity should be updated
      const updatedSession = await testPrisma.authSession.findFirst({
        where: { id: session.id },
      });
      expect(updatedSession!.lastActivityAt.getTime()).toBeGreaterThan(lastActivity.getTime());
    });

    it('should not update activity when within throttle interval', async () => {
      const lastActivity = new Date(Date.now() - ACTIVITY_UPDATE_THROTTLE_MS / 2); // Half of throttle
      const { session, token } = await createTestSession({ lastActivityAt: lastActivity });

      const ctx = await createContext({ headers: createHeaders(token) });

      // Session should be valid
      expect(ctx.sessionId).toBe(session.id);

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Last activity should NOT be updated (still the same as when created)
      const updatedSession = await testPrisma.authSession.findFirst({
        where: { id: session.id },
      });
      expect(updatedSession!.lastActivityAt.getTime()).toBe(lastActivity.getTime());
    });

    it('should not change token regardless of idle time', async () => {
      // Even with long idle time (but within idle timeout), token should remain the same
      const lastActivity = new Date(Date.now() - IDLE_TIMEOUT_MS / 2);
      const { session, token } = await createTestSession({ lastActivityAt: lastActivity });

      await createContext({ headers: createHeaders(token) });

      // Wait for async update
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Token should remain unchanged
      const updatedSession = await testPrisma.authSession.findFirst({
        where: { id: session.id },
      });
      expect(updatedSession!.token).toBe(token);
    });
  });
});

describe('sessionProcedure', () => {
  const MISSING_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

  function createCaller() {
    const testRouter = trpc.router({
      probe: trpc.sessionProcedure.query(({ ctx }) => ({
        id: ctx.session.id,
        status: ctx.session.status,
      })),
      withExtraInput: trpc.sessionProcedure
        .input(z.object({ extra: z.string() }))
        .query(({ ctx, input }) => ({ id: ctx.session.id, extra: input.extra })),
      requiresRunning: trpc.runningSessionProcedure.mutation(() => 'ok'),
    });
    return testRouter.createCaller({ sessionId: 'auth-session-id' });
  }

  it('loads the session into ctx and merges additional input', async () => {
    const session = await createTestSession({ name: 'Probe', status: 'stopped' });
    const caller = createCaller();

    expect(await caller.probe({ sessionId: session.id })).toEqual({
      id: session.id,
      status: 'stopped',
    });
    expect(await caller.withExtraInput({ sessionId: session.id, extra: 'x' })).toEqual({
      id: session.id,
      extra: 'x',
    });
  });

  it('throws NOT_FOUND for an unknown session and rejects non-uuid ids', async () => {
    const caller = createCaller();
    await expect(caller.probe({ sessionId: MISSING_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Session not found',
    });
    await expect(caller.probe({ sessionId: 'nope' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('requires authentication before looking the session up', async () => {
    const testRouter = trpc.router({ probe: trpc.sessionProcedure.query(() => 'ok') });
    const caller = testRouter.createCaller({ sessionId: null });
    await expect(caller.probe({ sessionId: MISSING_ID })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('runningSessionProcedure rejects sessions that are not running', async () => {
    const stopped = await createTestSession({ name: 'Stopped', status: 'stopped' });
    const running = await createTestSession({ name: 'Running', status: 'running' });
    const caller = createCaller();

    await expect(caller.requiresRunning({ sessionId: stopped.id })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Session is not running',
    });
    expect(await caller.requiresRunning({ sessionId: running.id })).toBe('ok');
  });
});
