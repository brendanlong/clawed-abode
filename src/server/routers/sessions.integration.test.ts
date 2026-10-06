import { resetEnvCache } from '@/lib/env';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { createNoRepoSession, createTestSession } from '@/test/fixtures';

// Mock external services that have real dependencies (git clone)
const mockCloneRepo = vi.hoisted(() => vi.fn());
const mockCreateEmptyWorkspace = vi.hoisted(() => vi.fn());
const mockRemoveWorkspace = vi.hoisted(() => vi.fn());

vi.mock('../services/worktree-manager', () => ({
  cloneRepo: mockCloneRepo,
  createEmptyWorkspace: mockCreateEmptyWorkspace,
  removeWorkspace: mockRemoveWorkspace,
  getSessionWorkspacePath: vi.fn((sessionId: string) => `/worktrees/${sessionId}`),
}));

// Mock claude-runner
const mockRefreshSessionSettings = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSendUserMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockStopSession = vi.hoisted(() => vi.fn());
const mockReviveSession = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCleanupSession = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../services/claude-runner', () => ({
  sendUserMessage: mockSendUserMessage,
  stopSession: mockStopSession,
  cleanupSession: mockCleanupSession,
  isClaudeRunning: vi.fn().mockReturnValue(false),
  isSessionBackgroundActive: vi.fn().mockReturnValue(false),
  refreshSessionSettings: mockRefreshSessionSettings,
  reviveSession: mockReviveSession,
}));
vi.mock('../services/rate-limit-pause', () => ({
  isSessionRateLimitPaused: vi.fn().mockReturnValue(false),
  recomputeRateLimitHolds: vi.fn().mockResolvedValue(undefined),
}));

// Mock settings-merger
vi.mock('../services/settings-merger', () => ({
  loadMergedSessionSettings: vi.fn().mockResolvedValue({
    systemPrompt: 'test prompt',
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

vi.mock('@/lib/logger', async () => (await import('@/test/mock-logger')).mockLoggerModule());

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
    resetEnvCache();
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

    it('should send the initial prompt once the clone finishes', async () => {
      mockCloneRepo.mockResolvedValueOnce({ repoPath: 'repo' });
      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.create({
        name: 'Issue Session',
        repoFullName: 'owner/repo',
        branch: 'main',
        initialPrompt: '  Fix the bug in issue #123  ',
      });

      await vi.waitFor(() => {
        expect(mockSendUserMessage).toHaveBeenCalledWith(
          result.session.id,
          'Fix the bug in issue #123'
        );
      });
      const dbSession = await testPrisma.session.findUnique({ where: { id: result.session.id } });
      expect(dbSession?.status).toBe('running');
    });

    it('should store a per-session model override, trimmed', async () => {
      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.create({
        name: 'Model Session',
        claudeModel: '  sonnet  ',
      });

      expect(result.session.claudeModel).toBe('sonnet');

      const dbSession = await testPrisma.session.findUnique({
        where: { id: result.session.id },
      });
      expect(dbSession!.claudeModel).toBe('sonnet');
    });

    it('should store null claudeModel when omitted or blank', async () => {
      const caller = createCaller('auth-session-id');
      const omitted = await caller.sessions.create({ name: 'No Model' });
      const blank = await caller.sessions.create({ name: 'Blank Model', claudeModel: '   ' });

      expect(omitted.session.claudeModel).toBeNull();
      expect(blank.session.claudeModel).toBeNull();
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
            status: 'running',
          },
          {
            name: 'Session 2',
            repoUrl: 'https://github.com/owner/repo2.git',
            branch: 'develop',
            status: 'stopped',
          },
        ],
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.list({});

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions.map((s) => s.name).sort()).toEqual(['Session 1', 'Session 2']);
      // No in-memory query exists for either session, so no turn is active.
      expect(result.sessions.every((s) => s.turnActive === false)).toBe(true);
    });

    it('orders sessions by lastActivityAt, most recent first', async () => {
      await testPrisma.session.createMany({
        data: [
          {
            name: 'Oldest activity',
            status: 'stopped',
            lastActivityAt: new Date('2024-01-01T00:00:00Z'),
          },
          {
            name: 'Newest activity',
            status: 'stopped',
            lastActivityAt: new Date('2024-03-01T00:00:00Z'),
          },
          {
            name: 'Middle activity',
            status: 'running',
            lastActivityAt: new Date('2024-02-01T00:00:00Z'),
          },
        ],
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.list({});

      expect(result.sessions.map((s) => s.name)).toEqual([
        'Newest activity',
        'Middle activity',
        'Oldest activity',
      ]);
    });

    it('should filter by status', async () => {
      await testPrisma.session.createMany({
        data: [
          {
            name: 'Running 1',
            repoUrl: 'https://github.com/owner/repo.git',
            branch: 'main',
            status: 'running',
          },
          {
            name: 'Running 2',
            repoUrl: 'https://github.com/owner/repo.git',
            branch: 'main',
            status: 'running',
          },
          {
            name: 'Stopped 1',
            repoUrl: 'https://github.com/owner/repo.git',
            branch: 'main',
            status: 'stopped',
          },
        ],
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.list({ status: 'running' });

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions.every((s) => s.status === 'running')).toBe(true);
    });

    it('returns only archived sessions when status is archived, none otherwise', async () => {
      await testPrisma.session.createMany({
        data: [
          { name: 'Active', status: 'running' },
          { name: 'Archived', status: 'archived' },
        ],
      });

      const caller = createCaller('auth-session-id');
      expect((await caller.sessions.list({})).sessions.map((s) => s.name)).toEqual(['Active']);
      expect(
        (await caller.sessions.list({ status: 'archived' })).sessions.map((s) => s.name)
      ).toEqual(['Archived']);
    });

    it('paginates by (lastActivityAt, id) cursor without skipping ties', async () => {
      const sameInstant = new Date('2024-02-01T00:00:00Z');
      await testPrisma.session.createMany({
        data: [
          { name: 'Newest', status: 'stopped', lastActivityAt: new Date('2024-03-01T00:00:00Z') },
          { name: 'Tie A', status: 'stopped', lastActivityAt: sameInstant },
          { name: 'Tie B', status: 'stopped', lastActivityAt: sameInstant },
          { name: 'Tie C', status: 'stopped', lastActivityAt: sameInstant },
          { name: 'Oldest', status: 'stopped', lastActivityAt: new Date('2024-01-01T00:00:00Z') },
        ],
      });

      const caller = createCaller('auth-session-id');
      const seen: string[] = [];
      let cursor: { at: string; id: string } | undefined;
      let pages = 0;
      do {
        const page = await caller.sessions.list({ limit: 2, cursor });
        expect(page.sessions.length).toBeLessThanOrEqual(2);
        seen.push(...page.sessions.map((s) => s.name));
        cursor = page.nextCursor;
        pages++;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      expect(seen[0]).toBe('Newest');
      expect(seen[4]).toBe('Oldest');
    });

    it('decodes the persisted pull request and omits heavy columns', async () => {
      const pr = {
        number: 7,
        title: 'Add thing',
        state: 'open',
        draft: false,
        url: 'https://github.com/owner/repo/pull/7',
        author: 'octocat',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      await testPrisma.session.createMany({
        data: [
          { name: 'With PR', status: 'running', pullRequest: JSON.stringify(pr) },
          { name: 'Bad JSON', status: 'running', pullRequest: '{not json' },
        ],
      });

      const caller = createCaller('auth-session-id');
      const { sessions } = await caller.sessions.list({});
      expect(sessions.find((s) => s.name === 'With PR')?.pullRequest).toEqual(pr);
      expect(sessions.find((s) => s.name === 'Bad JSON')?.pullRequest).toBeNull();
      expect(sessions[0]).not.toHaveProperty('sessionScope');
      expect(sessions[0]).not.toHaveProperty('messageSequence');
    });
  });

  describe('get', () => {
    it('should get a session by ID from the database', async () => {
      const session = await createNoRepoSession({
        name: 'Test Session',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.get({ sessionId: session.id });

      expect(result.session.id).toBe(session.id);
      expect(result.session.name).toBe('Test Session');
      expect(result.session.status).toBe('running');
    });
  });

  describe('byAgentName', () => {
    it('finds the session with that agent name, including archived ones', async () => {
      const session = await createNoRepoSession({
        name: 'Sender',
        agentName: 'math-opus-1a2b',
        status: 'archived',
      });
      await createNoRepoSession({ name: 'Other', agentName: 'other-cafe' });

      const result = await createCaller('auth-session-id').sessions.byAgentName({
        agentName: 'math-opus-1a2b',
      });

      expect(result.session).toEqual({ id: session.id, name: 'Sender' });
    });

    it('returns null for an unknown agent name', async () => {
      const result = await createCaller('auth-session-id').sessions.byAgentName({
        agentName: 'nobody-0000',
      });

      expect(result.session).toBeNull();
    });
  });

  describe('getEditorUrl', () => {
    afterEach(() => {
      delete process.env.CODE_SERVER_URL;
      resetEnvCache();
    });

    it('returns a deep link into the session worktree when configured', async () => {
      process.env.CODE_SERVER_URL = 'https://host.ts.net:8443';
      resetEnvCache();
      const session = await createNoRepoSession({
        name: 'Test Session',
        repoPath: 'repo',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.getEditorUrl({ sessionId: session.id });

      // Opens the workspace root (not the repo subfolder) so all of the
      // session's files are visible — the repo clone plus the uploads/ sibling.
      expect(result.url).toBe(
        `https://host.ts.net:8443/?folder=${encodeURIComponent(`/worktrees/${session.id}`)}`
      );
    });

    it('returns null when CODE_SERVER_URL is not configured', async () => {
      const session = await createNoRepoSession({
        name: 'Test Session',
        repoPath: 'repo',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.getEditorUrl({ sessionId: session.id });

      expect(result.url).toBeNull();
    });

    it('returns null for an archived session even when configured', async () => {
      process.env.CODE_SERVER_URL = 'https://host.ts.net:8443';
      resetEnvCache();
      const session = await createNoRepoSession({
        name: 'Archived Session',
        repoPath: 'repo',
        status: 'archived',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.getEditorUrl({ sessionId: session.id });

      expect(result.url).toBeNull();
    });
  });

  describe('start', () => {
    it('should start a stopped session and update the database', async () => {
      const session = await createTestSession({
        name: 'Stopped Session',
        status: 'stopped',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.start({ sessionId: session.id });

      expect(result.session.status).toBe('running');

      // Verify database was updated
      const dbSession = await testPrisma.session.findUnique({ where: { id: session.id } });
      expect(dbSession!.status).toBe('running');
      // Its CLI starts now, so other sessions can reach it before it gets a prompt.
      expect(mockReviveSession).toHaveBeenCalledWith(session.id);
    });

    it('should not start an already running session', async () => {
      const session = await createTestSession({
        name: 'Running Session',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.start({ sessionId: session.id });

      expect(result.session.status).toBe('running');
    });

    it('should reject starting a session that is still being set up', async () => {
      const session = await createNoRepoSession({ name: 'Creating', status: 'creating' });

      const caller = createCaller('auth-session-id');
      await expect(caller.sessions.start({ sessionId: session.id })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });

    it('should refuse to revive a session whose setup failed, even via stop', async () => {
      mockCloneRepo.mockRejectedValueOnce(new Error('clone failed'));
      const caller = createCaller('auth-session-id');
      const { session } = await caller.sessions.create({
        name: 'Failed setup',
        repoFullName: 'owner/repo',
        branch: 'main',
      });
      await vi.waitFor(async () => {
        const row = await testPrisma.session.findUniqueOrThrow({ where: { id: session.id } });
        expect(row.status).toBe('error');
      });

      const { session: view } = await caller.sessions.get({ sessionId: session.id });
      expect(view).toMatchObject({ canStart: false, canStop: false });

      await expect(caller.sessions.start({ sessionId: session.id })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      expect((await caller.sessions.stop({ sessionId: session.id })).session.status).toBe('error');
      await expect(caller.sessions.start({ sessionId: session.id })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });

      const row = await testPrisma.session.findUniqueOrThrow({ where: { id: session.id } });
      expect(row).toMatchObject({ status: 'error', repoPath: '' });
    });

    it('should reject starting an archived session', async () => {
      const session = await createNoRepoSession({
        name: 'Archived Session',
        status: 'archived',
      });

      const caller = createCaller('auth-session-id');
      await expect(caller.sessions.start({ sessionId: session.id })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });
  });

  describe('stop', () => {
    it('should leave a session that is still being set up to its setup', async () => {
      const session = await createNoRepoSession({ name: 'Creating', status: 'creating' });

      const result = await createCaller('auth-session-id').sessions.stop({
        sessionId: session.id,
      });

      expect(result.session.status).toBe('creating');
      const dbSession = await testPrisma.session.findUniqueOrThrow({ where: { id: session.id } });
      expect(dbSession.status).toBe('creating');
    });

    it('should stop a running session and update the database', async () => {
      const session = await createTestSession({
        name: 'Running Session',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.stop({ sessionId: session.id });

      expect(result.session.status).toBe('stopped');
      // The UI offers Start/Stop from these, not from its own copy of the rule.
      expect(result.session).toMatchObject({ canStart: true, canStop: false });

      // Verify database was updated
      const dbSession = await testPrisma.session.findUnique({ where: { id: session.id } });
      expect(dbSession!.status).toBe('stopped');
    });

    it('should withdraw a pending rate-limit resume nudge', async () => {
      const session = await createTestSession({ name: 'Paused Session' });
      await testPrisma.session.update({
        where: { id: session.id },
        data: { resumeAfterRateLimit: true },
      });

      const caller = createCaller('auth-session-id');
      await caller.sessions.stop({ sessionId: session.id });

      const dbSession = await testPrisma.session.findUniqueOrThrow({ where: { id: session.id } });
      expect(dbSession.resumeAfterRateLimit).toBe(false);
    });

    it('should tear down the query but leave an archived session archived', async () => {
      const session = await createNoRepoSession({
        name: 'Archived Session',
        status: 'archived',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.stop({ sessionId: session.id });

      expect(result.session.status).toBe('archived');

      // A query can be re-established on an archived session by a concurrent
      // send, so stop still has to kill it — it just must not un-archive.
      expect(mockStopSession).toHaveBeenCalledWith(session.id);

      const dbSession = await testPrisma.session.findUnique({ where: { id: session.id } });
      expect(dbSession!.status).toBe('archived');
    });
  });

  describe('rename', () => {
    it('should update the session name without changing the id', async () => {
      const session = await createNoRepoSession({
        name: 'Old Name',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.rename({ sessionId: session.id, name: 'New Name' });

      expect(result.session.id).toBe(session.id);
      expect(result.session.name).toBe('New Name');

      const dbSession = await testPrisma.session.findUnique({ where: { id: session.id } });
      expect(dbSession!.name).toBe('New Name');
      expect(dbSession!.id).toBe(session.id);
    });

    it('should trim whitespace from the new name', async () => {
      const session = await createNoRepoSession({
        name: 'Old Name',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.rename({
        sessionId: session.id,
        name: '  Trimmed Name  ',
      });

      expect(result.session.name).toBe('Trimmed Name');
    });

    it('should reject an empty name', async () => {
      const session = await createNoRepoSession({
        name: 'Old Name',
      });

      const caller = createCaller('auth-session-id');
      await expect(
        caller.sessions.rename({ sessionId: session.id, name: '   ' })
      ).rejects.toThrow();
    });

    it('should emit a session update event', async () => {
      const session = await createNoRepoSession({
        name: 'Old Name',
      });

      mockSseEvents.emitSessionUpdate.mockClear();
      const caller = createCaller('auth-session-id');
      await caller.sessions.rename({ sessionId: session.id, name: 'New Name' });

      expect(mockSseEvents.emitSessionUpdate).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ name: 'New Name' })
      );
    });
  });

  describe('setModel', () => {
    const createRunningSession = (claudeModel: string | null = null) =>
      createNoRepoSession({
        name: 'Model Session',
        claudeModel,
      });

    it('should set the per-session model override', async () => {
      const session = await createRunningSession();

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.setModel({
        sessionId: session.id,
        claudeModel: 'sonnet',
      });

      expect(result.session.claudeModel).toBe('sonnet');

      const dbSession = await testPrisma.session.findUnique({ where: { id: session.id } });
      expect(dbSession!.claudeModel).toBe('sonnet');
    });

    it('should trim the model and collapse blank to null', async () => {
      const session = await createRunningSession('opus');

      const caller = createCaller('auth-session-id');
      const trimmed = await caller.sessions.setModel({
        sessionId: session.id,
        claudeModel: '  haiku  ',
      });
      expect(trimmed.session.claudeModel).toBe('haiku');

      const cleared = await caller.sessions.setModel({
        sessionId: session.id,
        claudeModel: '   ',
      });
      expect(cleared.session.claudeModel).toBeNull();
    });

    it('should clear the override with null', async () => {
      const session = await createRunningSession('opus');

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.setModel({
        sessionId: session.id,
        claudeModel: null,
      });

      expect(result.session.claudeModel).toBeNull();
    });

    it('should apply the change to the live query', async () => {
      const session = await createRunningSession();
      mockRefreshSessionSettings.mockClear();

      const caller = createCaller('auth-session-id');
      await caller.sessions.setModel({ sessionId: session.id, claudeModel: 'sonnet' });

      expect(mockRefreshSessionSettings).toHaveBeenCalledWith(session.id);
    });

    it('should emit a session update event', async () => {
      const session = await createRunningSession();
      mockSseEvents.emitSessionUpdate.mockClear();

      const caller = createCaller('auth-session-id');
      await caller.sessions.setModel({ sessionId: session.id, claudeModel: 'sonnet' });

      expect(mockSseEvents.emitSessionUpdate).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ claudeModel: 'sonnet' })
      );
    });

    it('should reject changing the model of an archived session', async () => {
      const session = await createNoRepoSession({
        name: 'Archived',
        status: 'archived',
      });

      const caller = createCaller('auth-session-id');
      await expect(
        caller.sessions.setModel({ sessionId: session.id, claudeModel: 'sonnet' })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    });
  });

  describe('delete (archive)', () => {
    it('should archive a session and clean up resources but keep messages', async () => {
      const session = await createTestSession({
        name: 'Session to archive',
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
      // Verify messages were preserved
      const messages = await testPrisma.message.findMany({ where: { sessionId: session.id } });
      expect(messages).toHaveLength(1);
    });

    it('removes the workspace only after the session processes are stopped', async () => {
      const session = await createTestSession({ name: 'Session with a daemon' });
      let releaseStop!: () => void;
      mockCleanupSession.mockReturnValueOnce(new Promise<void>((r) => (releaseStop = r)));
      mockRemoveWorkspace.mockResolvedValue(undefined);

      const caller = createCaller('auth-session-id');
      const deleting = caller.sessions.delete({ sessionId: session.id });
      // Archived (so nothing can revive it) before the stop finishes, but the
      // workspace is kept until then.
      await vi.waitFor(async () => {
        const row = await testPrisma.session.findUnique({ where: { id: session.id } });
        expect(row?.status).toBe('archived');
      });
      expect(mockRemoveWorkspace).not.toHaveBeenCalled();

      releaseStop();
      await deleting;
      expect(mockRemoveWorkspace).toHaveBeenCalledWith(session.id);
    });

    it('should be idempotent for already archived sessions', async () => {
      const session = await createTestSession({
        name: 'Already archived session',
        status: 'archived',
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.sessions.delete({ sessionId: session.id });

      expect(result).toEqual({ success: true });
      expect(mockRemoveWorkspace).not.toHaveBeenCalled();
    });
  });

  // A concurrent delete can archive the row after sessionProcedure loaded it.
  // Simulate that by archiving the row but handing the procedure the stale copy.
  describe('racing a concurrent archive', () => {
    const archivedBehindTheLoad = async (status: string) => {
      const session = await createNoRepoSession({ name: 'Racing', status });
      vi.spyOn(testPrisma.session, 'findUnique').mockResolvedValueOnce(session);
      await testPrisma.session.update({ where: { id: session.id }, data: { status: 'archived' } });
      return session;
    };
    const statusOf = async (id: string) =>
      (await testPrisma.session.findUniqueOrThrow({ where: { id } })).status;

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('stop leaves the session archived', async () => {
      const session = await archivedBehindTheLoad('running');

      const result = await createCaller('auth-session-id').sessions.stop({
        sessionId: session.id,
      });

      expect(result.session.status).toBe('archived');
      expect(await statusOf(session.id)).toBe('archived');
      expect(mockStopSession).toHaveBeenCalledWith(session.id);
    });

    it('start refuses to revive the session', async () => {
      const session = await archivedBehindTheLoad('stopped');

      await expect(
        createCaller('auth-session-id').sessions.start({ sessionId: session.id })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(await statusOf(session.id)).toBe('archived');
    });

    it('setModel refuses to write', async () => {
      const session = await archivedBehindTheLoad('running');

      await expect(
        createCaller('auth-session-id').sessions.setModel({
          sessionId: session.id,
          claudeModel: 'sonnet',
        })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      const row = await testPrisma.session.findUniqueOrThrow({ where: { id: session.id } });
      expect(row.claudeModel).toBeNull();
    });

    it('a second delete leaves workspace removal to the first', async () => {
      const session = await archivedBehindTheLoad('running');

      await createCaller('auth-session-id').sessions.delete({ sessionId: session.id });

      // Still tears down, in case a concurrent send re-established a query.
      expect(mockCleanupSession).toHaveBeenCalledWith(session.id);
      expect(mockRemoveWorkspace).not.toHaveBeenCalled();
      expect(mockSseEvents.emitSessionUpdate).not.toHaveBeenCalled();
    });

    it('setup deleted before it starts cloning never clones', async () => {
      // Archive the row just ahead of setup's first write.
      const updateManyAndReturn = testPrisma.session.updateManyAndReturn.bind(testPrisma.session);
      vi.spyOn(testPrisma.session, 'updateManyAndReturn').mockImplementationOnce(((
        args: Parameters<typeof updateManyAndReturn>[0]
      ) =>
        testPrisma.session
          .updateMany({ data: { status: 'archived' } })
          .then(() => updateManyAndReturn(args))) as unknown as typeof updateManyAndReturn);

      const { session } = await createCaller('auth-session-id').sessions.create({
        name: 'Deleted before clone',
        repoFullName: 'owner/repo',
        branch: 'main',
        initialPrompt: 'Do something',
      });

      await vi.waitFor(() => expect(testPrisma.session.updateManyAndReturn).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockCloneRepo).not.toHaveBeenCalled();
      expect(mockSendUserMessage).not.toHaveBeenCalled();
      expect(await statusOf(session.id)).toBe('archived');
    });

    it('a clone that finishes after delete leaves the session archived and cleans up', async () => {
      let finishClone!: () => void;
      mockCloneRepo.mockReturnValueOnce(
        new Promise((resolve) => (finishClone = () => resolve({ repoPath: 'repo' })))
      );
      mockRemoveWorkspace.mockResolvedValue(undefined);
      const caller = createCaller('auth-session-id');
      const { session } = await caller.sessions.create({
        name: 'Deleted mid-clone',
        repoFullName: 'owner/repo',
        branch: 'main',
        initialPrompt: 'Do something',
      });
      await vi.waitFor(() => expect(mockCloneRepo).toHaveBeenCalled());

      await caller.sessions.delete({ sessionId: session.id });
      expect(mockRemoveWorkspace).toHaveBeenCalledTimes(1);

      finishClone();
      // The late clone wrote into the removed workspace, so setup removes it again.
      await vi.waitFor(() => expect(mockRemoveWorkspace).toHaveBeenCalledTimes(2));
      expect(await statusOf(session.id)).toBe('archived');
      expect(mockSendUserMessage).not.toHaveBeenCalled();
    });

    it('a clone that fails after delete leaves the session archived', async () => {
      let failClone!: () => void;
      mockCloneRepo.mockReturnValueOnce(
        new Promise((_, reject) => (failClone = () => reject(new Error('clone failed'))))
      );
      mockRemoveWorkspace.mockResolvedValue(undefined);
      const caller = createCaller('auth-session-id');
      const { session } = await caller.sessions.create({
        name: 'Deleted mid-clone',
        repoFullName: 'owner/repo',
        branch: 'main',
      });
      await vi.waitFor(() => expect(mockCloneRepo).toHaveBeenCalled());

      await caller.sessions.delete({ sessionId: session.id });
      failClone();

      await vi.waitFor(() => expect(mockRemoveWorkspace).toHaveBeenCalledTimes(2));
      const row = await testPrisma.session.findUniqueOrThrow({ where: { id: session.id } });
      expect(row.status).toBe('archived');
      expect(row.statusMessage).not.toBe('clone failed');
    });
  });
});
