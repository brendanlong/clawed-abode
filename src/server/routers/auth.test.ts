import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// Mock Prisma - vi.hoisted ensures the mock is defined before vi.mock hoisting
const mockPrisma = vi.hoisted(() => ({
  authSession: {
    create: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: mockPrisma,
}));

// Mock auth functions with vi.hoisted
const mockVerifyPassword = vi.hoisted(() => vi.fn());
const mockGenerateSessionToken = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    verifyPassword: mockVerifyPassword,
    generateSessionToken: mockGenerateSessionToken,
  };
});

// Mock env with vi.hoisted
const mockEnv = vi.hoisted(() => ({
  PASSWORD_HASH: 'test-hash' as string | undefined,
}));

vi.mock('@/lib/env', () => ({
  env: mockEnv,
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));

// Import the router after mocks are set up
import { authRouter } from './auth';
import { router } from '../trpc';

// Create a test caller with proper context
const createCaller = (sessionId: string | null) => {
  // Create a test router that uses the auth router
  const testRouter = router({
    auth: authRouter,
  });

  return testRouter.createCaller({ sessionId });
};

describe('authRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.PASSWORD_HASH = 'test-hash';
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('login', () => {
    it('should login successfully with correct password', async () => {
      const testToken = 'generated-test-token';
      mockVerifyPassword.mockResolvedValue(true);
      mockGenerateSessionToken.mockReturnValue(testToken);
      mockPrisma.authSession.create.mockResolvedValue({
        id: 'session-id',
        token: testToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
      });

      const caller = createCaller(null);
      const result = await caller.auth.login({
        password: 'correct-password',
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
      });

      expect(result.token).toBe(testToken);
      expect(mockVerifyPassword).toHaveBeenCalledWith('correct-password', 'test-hash');
      expect(mockGenerateSessionToken).toHaveBeenCalled();
      expect(mockPrisma.authSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          token: testToken,
          ipAddress: '127.0.0.1',
          userAgent: 'test-agent',
        }),
      });
    });

    it('should reject invalid password', async () => {
      mockVerifyPassword.mockResolvedValue(false);

      const caller = createCaller(null);

      await expect(caller.auth.login({ password: 'wrong-password' })).rejects.toThrow(TRPCError);

      await expect(caller.auth.login({ password: 'wrong-password' })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Invalid password',
      });
    });

    it('should throw error if PASSWORD_HASH is not configured', async () => {
      mockEnv.PASSWORD_HASH = undefined;

      const caller = createCaller(null);

      await expect(caller.auth.login({ password: 'any-password' })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Authentication not configured. Set PASSWORD_HASH environment variable.',
      });
    });

    it('should throw error if password verification fails with invalid hash format', async () => {
      mockVerifyPassword.mockRejectedValue(new Error('Invalid hash format'));

      const caller = createCaller(null);

      await expect(caller.auth.login({ password: 'any-password' })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Invalid PASSWORD_HASH format. Generate with: pnpm hash-password <yourpassword>',
      });
    });
  });

  describe('logout', () => {
    it('should delete the current session', async () => {
      mockPrisma.authSession.delete.mockResolvedValue({
        id: 'current-session-id',
      });

      const caller = createCaller('current-session-id');
      const result = await caller.auth.logout();

      expect(result).toEqual({ success: true });
      expect(mockPrisma.authSession.delete).toHaveBeenCalledWith({
        where: { id: 'current-session-id' },
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(caller.auth.logout()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('logoutAll', () => {
    it('should delete all sessions', async () => {
      mockPrisma.authSession.deleteMany.mockResolvedValue({ count: 5 });

      const caller = createCaller('some-session-id');
      const result = await caller.auth.logoutAll();

      expect(result).toEqual({ success: true });
      expect(mockPrisma.authSession.deleteMany).toHaveBeenCalledWith({});
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(caller.auth.logoutAll()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('listSessions', () => {
    it('should list all sessions with isCurrent flag', async () => {
      const now = new Date();
      const sessions = [
        {
          id: 'session-1',
          createdAt: now,
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          ipAddress: '127.0.0.1',
          userAgent: 'Chrome',
        },
        {
          id: 'session-2',
          createdAt: now,
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          ipAddress: '192.168.1.1',
          userAgent: 'Firefox',
        },
      ];

      mockPrisma.authSession.findMany.mockResolvedValue(sessions);

      const caller = createCaller('session-1');
      const result = await caller.auth.listSessions();

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0]).toMatchObject({
        id: 'session-1',
        isCurrent: true,
      });
      expect(result.sessions[1]).toMatchObject({
        id: 'session-2',
        isCurrent: false,
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(caller.auth.listSessions()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('deleteSession', () => {
    it('should delete another session', async () => {
      mockPrisma.authSession.delete.mockResolvedValue({
        id: 'other-session-id',
      });

      const caller = createCaller('current-session-id');
      const result = await caller.auth.deleteSession({
        sessionId: 'other-session-id',
      });

      expect(result).toEqual({ success: true });
      expect(mockPrisma.authSession.delete).toHaveBeenCalledWith({
        where: { id: 'other-session-id' },
      });
    });

    it('should prevent deleting current session', async () => {
      const caller = createCaller('current-session-id');

      await expect(
        caller.auth.deleteSession({ sessionId: 'current-session-id' })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Use logout to delete your current session',
      });

      expect(mockPrisma.authSession.delete).not.toHaveBeenCalled();
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.auth.deleteSession({ sessionId: 'some-session-id' })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });
});
