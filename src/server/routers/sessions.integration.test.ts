import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

// Mock external services that have real dependencies (git clone)
const mockCloneRepo = vi.hoisted(() => vi.fn());
const mockCreateEmptyWorkspace = vi.hoisted(() => vi.fn());
const mockRemoveWorkspace = vi.hoisted(() => vi.fn());

vi.mock('../services/worktree-manager', () => ({
  cloneRepo: mockCloneRepo,
  createEmptyWorkspace: mockCreateEmptyWorkspace,
  removeWorkspace: mockRemoveWorkspace,
  getSessionWorkingDir: vi.fn((sessionId: string, repoPath: string) =>
    repoPath ? `/worktrees/${sessionId}/${repoPath}` : `/worktrees/${sessionId}`
  ),
}));

// Mock claude-runner
vi.mock('../services/claude-runner', () => ({
  buildSystemPrompt: vi.fn().mockReturnValue('test system prompt'),
  runClaudeCommand: vi.fn().mockResolvedValue(undefined),
  stopSession: vi.fn().mockResolvedValue(undefined),
}));

// Mock settings-merger
vi.mock('../services/settings-merger', () => ({
  loadMergedSessionSettings: vi.fn().mockResolvedValue({
    systemPrompt: 'test prompt',
    customSystemPrompt: null,
    globalSettings: {
      systemPromptOverride: null,
      systemPromptOverrideEnabled: false,
      systemPromptAppend: null,
    },
    envVars: [],
    mcpServers: [],
    claudeModel: null,
    claudeApiKey: null,
  }),
}));

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

// These will be set in beforeAll after the test DB is set up
let sessionsRouter: Awaited<typeof import('./sessions')>['sessionsRouter'];
let router: Awaited<typeof import('../trpc')>['router'];

const createCaller = (sessionId: string | null) => {
  const testRouter = router({
    sessions: sessionsRouter,
  });
  return testRouter.createCaller({ sessionId });
};

describe('sessionsRouter integration', () => {
  beforeAll(async () => {
    // Set up the test database BEFORE importing the router
    await setupTestDb();

    // Now dynamically import the router (which imports prisma)
    const sessionsModule = await import('./sessions');
    const trpcModule = await import('../trpc');
    sessionsRouter = sessionsModule.sessionsRouter;
    router = trpcModule.router;

    process.env.GITHUB_TOKEN = 'test-github-token';
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a session in the database', async () => {
      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.create({
        name: 'Test Session',
        repoFullName: 'owner/repo',
        branch: 'main',
        initialPrompt: 'Work on something',
      });

      expect(result.session.name).toBe('Test Session');
      expect(result.session.status).toBe('creating');
      expect(result.session.repoUrl).toBe('https://github.com/owner/repo.git');
      expect(result.session.branch).toBe('main');

      // Verify in database
      const dbSession = await testPrisma.session.findUnique({
        where: { id: result.session.id },
      });
      expect(dbSession).toBeDefined();
      expect(dbSession!.name).toBe('Test Session');
    });

    it('should store initial prompt if provided', async () => {
      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.create({
        name: 'Issue Session',
        repoFullName: 'owner/repo',
        branch: 'main',
        initialPrompt: 'Fix the bug in issue #123',
      });

      expect(result.session.initialPrompt).toBe('Fix the bug in issue #123');

      const dbSession = await testPrisma.session.findUnique({
        where: { id: result.session.id },
      });
      expect(dbSession!.initialPrompt).toBe('Fix the bug in issue #123');
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.sessions.create({
          name: 'Test',
          repoFullName: 'owner/repo',
          branch: 'main',
          initialPrompt: 'Do something',
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
          initialPrompt: 'Do something',
        })
      ).rejects.toThrow();
    });

    it('should create a no-repo session with null repoUrl and branch', async () => {
      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.create({
        name: 'Workspace Session',
      });

      expect(result.session.name).toBe('Workspace Session');
      expect(result.session.status).toBe('creating');
      expect(result.session.repoUrl).toBeNull();
      expect(result.session.branch).toBeNull();

      // Verify in database
      const dbSession = await testPrisma.session.findUnique({
        where: { id: result.session.id },
      });
      expect(dbSession).toBeDefined();
      expect(dbSession!.repoUrl).toBeNull();
      expect(dbSession!.branch).toBeNull();
    });
  });

  describe('list', () => {
    it('should list all sessions from the database', async () => {
      // Create sessions directly in the database
      await testPrisma.session.createMany({
        data: [
          {
            name: 'Session 1',
            repoUrl: 'https://github.com/owner/repo1.git',
            branch: 'main',
            workspacePath: '/workspace/1',
            status: 'running',
          },
          {
            name: 'Session 2',
            repoUrl: 'https://github.com/owner/repo2.git',
            branch: 'develop',
            workspacePath: '/workspace/2',
            status: 'stopped',
          },
        ],
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.list();

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions.map((s) => s.name).sort()).toEqual(['Session 1', 'Session 2']);
    });

    it('should filter by status', async () => {
      await testPrisma.session.createMany({
        data: [
          {
            name: 'Running 1',
            repoUrl: 'https://github.com/owner/repo.git',
            branch: 'main',
            workspacePath: '/w/1',
            status: 'running',
          },
          {
            name: 'Running 2',
            repoUrl: 'https://github.com/owner/repo.git',
            branch: 'main',
            workspacePath: '/w/2',
            status: 'running',
          },
          {
            name: 'Stopped 1',
            repoUrl: 'https://github.com/owner/repo.git',
            branch: 'main',
            workspacePath: '/w/3',
            status: 'stopped',
          },
        ],
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.list({ status: 'running' });

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions.every((s) => s.status === 'running')).toBe(true);
    });

    it('should exclude archived sessions by default', async () => {
      await testPrisma.session.createMany({
        data: [
          {
            name: 'Active Session',
            repoUrl: 'https://github.com/owner/repo.git',
            branch: 'main',
            workspacePath: '/w/1',
            status: 'running',
          },
          {
            name: 'Archived Session',
            repoUrl: 'https://github.com/owner/repo.git',
            branch: 'main',
            workspacePath: '/w/2',
            status: 'archived',
            archivedAt: new Date(),
          },
        ],
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.list();

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].name).toBe('Active Session');
    });

    it('should include archived sessions when includeArchived is true', async () => {
      await testPrisma.session.createMany({
        data: [
          {
            name: 'Active Session',
            repoUrl: 'https://github.com/owner/repo.git',
            branch: 'main',
            workspacePath: '/w/1',
            status: 'running',
          },
          {
            name: 'Archived Session',
            repoUrl: 'https://github.com/owner/repo.git',
            branch: 'main',
            workspacePath: '/w/2',
            status: 'archived',
            archivedAt: new Date(),
          },
        ],
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.list({ includeArchived: true });

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions.map((s) => s.name).sort()).toEqual([
        'Active Session',
        'Archived Session',
      ]);
    });

    it('should return only archived sessions when filtering by archived status', async () => {
      await testPrisma.session.createMany({
        data: [
          {
            name: 'Active Session',
            repoUrl: 'https://github.com/owner/repo.git',
            branch: 'main',
            workspacePath: '/w/1',
            status: 'running',
          },
          {
            name: 'Archived Session',
            repoUrl: 'https://github.com/owner/repo.git',
            branch: 'main',
            workspacePath: '/w/2',
            status: 'archived',
            archivedAt: new Date(),
          },
        ],
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.list({ status: 'archived' });

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].name).toBe('Archived Session');
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);
      await expect(caller.sessions.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('get', () => {
    it('should get a session by ID from the database', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Test Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.get({ sessionId: session.id });

      expect(result.session.id).toBe(session.id);
      expect(result.session.name).toBe('Test Session');
      expect(result.session.status).toBe('running');
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.sessions.get({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Session not found',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);
      await expect(
        caller.sessions.get({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('start', () => {
    it('should start a stopped session and update the database', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Stopped Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'stopped',
        },
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.start({ sessionId: session.id });

      expect(result.session.status).toBe('running');

      // Verify database was updated
      const dbSession = await testPrisma.session.findUnique({ where: { id: session.id } });
      expect(dbSession!.status).toBe('running');
    });

    it('should not start an already running session', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Running Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.start({ sessionId: session.id });

      expect(result.session.status).toBe('running');
    });

    it('should reject starting an archived session', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Archived Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'archived',
          archivedAt: new Date(),
        },
      });

      const caller = createCaller('auth-session-id');
      await expect(caller.sessions.start({ sessionId: session.id })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.sessions.start({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('stop', () => {
    it('should stop a running session and update the database', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Running Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.stop({ sessionId: session.id });

      expect(result.session.status).toBe('stopped');

      // Verify database was updated
      const dbSession = await testPrisma.session.findUnique({ where: { id: session.id } });
      expect(dbSession!.status).toBe('stopped');
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.sessions.stop({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('delete (archive)', () => {
    it('should archive a session and clean up resources but keep messages', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Session to archive',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      // Add some messages
      await testPrisma.message.create({
        data: {
          sessionId: session.id,
          sequence: 0,
          type: 'user',
          content: '{}',
        },
      });

      mockRemoveWorkspace.mockResolvedValue(undefined);

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.delete({ sessionId: session.id });

      expect(result).toEqual({ success: true });
      expect(mockRemoveWorkspace).toHaveBeenCalledWith(session.id);

      // Verify session was archived (not deleted)
      const dbSession = await testPrisma.session.findUnique({ where: { id: session.id } });
      expect(dbSession).not.toBeNull();
      expect(dbSession!.status).toBe('archived');
      expect(dbSession!.archivedAt).not.toBeNull();
      // Verify messages were preserved
      const messages = await testPrisma.message.findMany({ where: { sessionId: session.id } });
      expect(messages).toHaveLength(1);
    });

    it('should be idempotent for already archived sessions', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Already archived session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'archived',
          archivedAt: new Date(),
        },
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.delete({ sessionId: session.id });

      expect(result).toEqual({ success: true });
      expect(mockRemoveWorkspace).not.toHaveBeenCalled();
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.sessions.delete({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('syncStatus', () => {
    it('should return session status as-is (no external state to sync)', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Session to sync',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.syncStatus({ sessionId: session.id });

      expect(result.session?.status).toBe('running');
    });
  });
});
