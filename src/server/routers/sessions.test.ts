import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Prisma with vi.hoisted
const mockPrisma = vi.hoisted(() => ({
  session: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: mockPrisma,
}));

// Mock git service with vi.hoisted
const mockCloneRepo = vi.hoisted(() => vi.fn());
const mockRemoveWorkspace = vi.hoisted(() => vi.fn());

vi.mock('../services/git', () => ({
  cloneRepo: mockCloneRepo,
  removeWorkspace: mockRemoveWorkspace,
}));

// Mock docker service with vi.hoisted
const mockCreateAndStartContainer = vi.hoisted(() => vi.fn());
const mockStopContainer = vi.hoisted(() => vi.fn());
const mockRemoveContainer = vi.hoisted(() => vi.fn());
const mockGetContainerStatus = vi.hoisted(() => vi.fn());

vi.mock('../services/docker', () => ({
  createAndStartContainer: mockCreateAndStartContainer,
  stopContainer: mockStopContainer,
  removeContainer: mockRemoveContainer,
  getContainerStatus: mockGetContainerStatus,
}));

// Mock events service with vi.hoisted
const mockSseEvents = vi.hoisted(() => ({
  emitSessionUpdate: vi.fn(),
}));

vi.mock('../services/events', () => ({
  sseEvents: mockSseEvents,
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
import { sessionsRouter } from './sessions';
import { router } from '../trpc';

// Create a test caller with proper context
const createCaller = (sessionId: string | null) => {
  const testRouter = router({
    sessions: sessionsRouter,
  });
  return testRouter.createCaller({ sessionId });
};

describe('sessionsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset process.env for each test
    process.env.GITHUB_TOKEN = 'test-github-token';
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('create', () => {
    it('should create a session and return immediately', async () => {
      const mockSession = {
        id: 'session-uuid',
        name: 'Test Session',
        repoUrl: 'https://github.com/owner/repo.git',
        branch: 'main',
        workspacePath: '',
        containerId: null,
        status: 'creating',
        statusMessage: 'Cloning repository...',
        initialPrompt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.session.create.mockResolvedValue(mockSession);

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.create({
        name: 'Test Session',
        repoFullName: 'owner/repo',
        branch: 'main',
      });

      expect(result.session).toMatchObject({
        name: 'Test Session',
        status: 'creating',
        statusMessage: 'Cloning repository...',
      });

      expect(mockPrisma.session.create).toHaveBeenCalledWith({
        data: {
          name: 'Test Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '',
          status: 'creating',
          statusMessage: 'Cloning repository...',
          initialPrompt: null,
        },
      });
    });

    it('should store initial prompt if provided', async () => {
      const mockSession = {
        id: 'session-uuid',
        name: 'Issue Session',
        repoUrl: 'https://github.com/owner/repo.git',
        branch: 'main',
        workspacePath: '',
        containerId: null,
        status: 'creating',
        statusMessage: 'Cloning repository...',
        initialPrompt: 'Fix the bug described in issue #123',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.session.create.mockResolvedValue(mockSession);

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.create({
        name: 'Issue Session',
        repoFullName: 'owner/repo',
        branch: 'main',
        initialPrompt: 'Fix the bug described in issue #123',
      });

      expect(result.session.initialPrompt).toBe('Fix the bug described in issue #123');
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.sessions.create({
          name: 'Test',
          repoFullName: 'owner/repo',
          branch: 'main',
        })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });

    it('should validate repoFullName format', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.sessions.create({
          name: 'Test',
          repoFullName: 'invalid-format',
          branch: 'main',
        })
      ).rejects.toThrow();
    });
  });

  describe('list', () => {
    it('should list all sessions', async () => {
      const mockSessions = [
        {
          id: 'session-1',
          name: 'Session 1',
          status: 'running',
          updatedAt: new Date(),
          messages: [{ id: 'msg-1', content: '{}' }],
        },
        {
          id: 'session-2',
          name: 'Session 2',
          status: 'stopped',
          updatedAt: new Date(),
          messages: [],
        },
      ];

      mockPrisma.session.findMany.mockResolvedValue(mockSessions);

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.list();

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0].lastMessage).toMatchObject({ id: 'msg-1' });
      expect(result.sessions[1].lastMessage).toBeNull();
    });

    it('should filter by status', async () => {
      mockPrisma.session.findMany.mockResolvedValue([]);

      const caller = createCaller('auth-session-id');
      await caller.sessions.list({ status: 'running' });

      expect(mockPrisma.session.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'running' },
        })
      );
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(caller.sessions.list()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('get', () => {
    it('should get a session by ID', async () => {
      const mockSession = {
        id: 'session-uuid',
        name: 'Test Session',
        status: 'running',
        messages: [{ id: 'msg-1', content: '{}' }],
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.get({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result.session).toMatchObject({
        id: 'session-uuid',
        name: 'Test Session',
      });
      expect(result.session.lastMessage).toMatchObject({ id: 'msg-1' });
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);

      const caller = createCaller('auth-session-id');

      await expect(
        caller.sessions.get({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Session not found',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.sessions.get({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('start', () => {
    it('should start a stopped session', async () => {
      const mockSession = {
        id: 'session-uuid',
        name: 'Test Session',
        status: 'stopped',
        workspacePath: '/data/workspaces/session-uuid',
        containerId: null,
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);
      mockCreateAndStartContainer.mockResolvedValue('new-container-id');
      mockPrisma.session.update.mockResolvedValue({
        ...mockSession,
        status: 'running',
        containerId: 'new-container-id',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.start({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result.session.status).toBe('running');
      expect(result.session.containerId).toBe('new-container-id');
      expect(mockCreateAndStartContainer).toHaveBeenCalled();
      expect(mockSseEvents.emitSessionUpdate).toHaveBeenCalled();
    });

    it('should return immediately if session is already running', async () => {
      const mockSession = {
        id: 'session-uuid',
        name: 'Test Session',
        status: 'running',
        containerId: 'existing-container-id',
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.start({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result.session.status).toBe('running');
      expect(mockCreateAndStartContainer).not.toHaveBeenCalled();
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);

      const caller = createCaller('auth-session-id');

      await expect(
        caller.sessions.start({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.sessions.start({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('stop', () => {
    it('should stop a running session', async () => {
      const mockSession = {
        id: 'session-uuid',
        name: 'Test Session',
        status: 'running',
        containerId: 'container-id',
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);
      mockStopContainer.mockResolvedValue(undefined);
      mockPrisma.session.update.mockResolvedValue({
        ...mockSession,
        status: 'stopped',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.stop({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result.session.status).toBe('stopped');
      expect(mockStopContainer).toHaveBeenCalledWith('container-id');
      expect(mockSseEvents.emitSessionUpdate).toHaveBeenCalled();
    });

    it('should handle session without container', async () => {
      const mockSession = {
        id: 'session-uuid',
        name: 'Test Session',
        status: 'creating',
        containerId: null,
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);
      mockPrisma.session.update.mockResolvedValue({
        ...mockSession,
        status: 'stopped',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.stop({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result.session.status).toBe('stopped');
      expect(mockStopContainer).not.toHaveBeenCalled();
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);

      const caller = createCaller('auth-session-id');

      await expect(
        caller.sessions.stop({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.sessions.stop({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('delete', () => {
    it('should delete a session and clean up resources', async () => {
      const mockSession = {
        id: 'session-uuid',
        name: 'Test Session',
        status: 'running',
        containerId: 'container-id',
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);
      mockRemoveContainer.mockResolvedValue(undefined);
      mockRemoveWorkspace.mockResolvedValue(undefined);
      mockPrisma.session.delete.mockResolvedValue(mockSession);

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.delete({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result).toEqual({ success: true });
      expect(mockRemoveContainer).toHaveBeenCalledWith('container-id');
      expect(mockRemoveWorkspace).toHaveBeenCalledWith('session-uuid');
      expect(mockPrisma.session.delete).toHaveBeenCalledWith({
        where: { id: 'session-uuid' },
      });
    });

    it('should handle session without container', async () => {
      const mockSession = {
        id: 'session-uuid',
        name: 'Test Session',
        status: 'stopped',
        containerId: null,
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);
      mockRemoveWorkspace.mockResolvedValue(undefined);
      mockPrisma.session.delete.mockResolvedValue(mockSession);

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.delete({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result).toEqual({ success: true });
      expect(mockRemoveContainer).not.toHaveBeenCalled();
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);

      const caller = createCaller('auth-session-id');

      await expect(
        caller.sessions.delete({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.sessions.delete({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('syncStatus', () => {
    it('should sync status from running container', async () => {
      const mockSession = {
        id: 'session-uuid',
        status: 'stopped',
        containerId: 'container-id',
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);
      mockGetContainerStatus.mockResolvedValue('running');
      mockPrisma.session.update.mockResolvedValue({
        ...mockSession,
        status: 'running',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.syncStatus({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result.session?.status).toBe('running');
    });

    it('should mark as stopped if container not found', async () => {
      const mockSession = {
        id: 'session-uuid',
        status: 'running',
        containerId: 'container-id',
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);
      mockGetContainerStatus.mockResolvedValue('not_found');
      mockPrisma.session.update.mockResolvedValue({
        ...mockSession,
        status: 'stopped',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.syncStatus({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result.session?.status).toBe('stopped');
    });

    it('should return session as-is if no container', async () => {
      const mockSession = {
        id: 'session-uuid',
        status: 'creating',
        containerId: null,
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.syncStatus({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result.session?.status).toBe('creating');
      expect(mockGetContainerStatus).not.toHaveBeenCalled();
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.sessions.syncStatus({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });
});
