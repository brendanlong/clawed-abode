import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

// Mock claude-runner service (has real Docker dependencies)
const mockSendUserMessage = vi.hoisted(() => vi.fn());
const mockSendUserMessages = vi.hoisted(() => vi.fn());
const mockInterruptClaude = vi.hoisted(() => vi.fn());
const mockIsClaudeRunningAsync = vi.hoisted(() => vi.fn());
const mockMarkLastMessageAsInterrupted = vi.hoisted(() => vi.fn());

vi.mock('../services/claude-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/claude-runner')>();
  return {
    ...actual,
    sendUserMessage: mockSendUserMessage,
    sendUserMessages: mockSendUserMessages,
    interruptClaude: mockInterruptClaude,
    isClaudeRunningAsync: mockIsClaudeRunningAsync,
    markLastMessageAsInterrupted: mockMarkLastMessageAsInterrupted,
  };
});

// Use real token estimation (pure function)
// vi.mock('@/lib/token-estimation') - not mocked

// Mock worktree-manager
vi.mock('../services/worktree-manager', () => ({
  getSessionWorkingDir: vi.fn((sessionId: string, repoPath: string) =>
    repoPath ? `/worktrees/${sessionId}/${repoPath}` : `/worktrees/${sessionId}`
  ),
  getSessionWorkspacePath: vi.fn((sessionId: string) => `/worktrees/${sessionId}`),
}));

// Mock uploads service (filesystem-backed). Its real behavior — storing files,
// sanitizing names, resolving/dropping stored names — is covered by
// uploads.integration.test.ts and the /api/upload route test.
const mockResolveUploadPaths = vi.hoisted(() => vi.fn());
vi.mock('../services/uploads', () => ({
  resolveUploadPaths: mockResolveUploadPaths,
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
let claudeRouter: Awaited<typeof import('./claude')>['claudeRouter'];
let router: Awaited<typeof import('../trpc')>['router'];

const createCaller = (sessionId: string | null) => {
  const testRouter = router({
    claude: claudeRouter,
  });
  return testRouter.createCaller({ sessionId });
};

describe('claudeRouter integration', () => {
  beforeAll(async () => {
    // Set up the test database BEFORE importing the router
    await setupTestDb();

    // Now dynamically import the router (which imports prisma)
    const claudeModule = await import('./claude');
    const trpcModule = await import('../trpc');
    claudeRouter = claudeModule.claudeRouter;
    router = trpcModule.router;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    vi.clearAllMocks();
  });

  describe('send', () => {
    it('should send a prompt to Claude for a running session', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Test Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      mockIsClaudeRunningAsync.mockResolvedValue(false);
      mockSendUserMessage.mockResolvedValue(undefined);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.send({
        sessionId: session.id,
        prompt: 'Hello, Claude!',
      });

      expect(result).toEqual({ success: true });
      expect(mockSendUserMessage).toHaveBeenCalledWith(session.id, 'Hello, Claude!', []);
    });

    it('resolves attachments to paths and passes them to sendUserMessage', async () => {
      const session = await testPrisma.session.create({
        data: { name: 'Attach Session', workspacePath: '/workspace/test', status: 'running' },
      });

      mockIsClaudeRunningAsync.mockResolvedValue(false);
      mockSendUserMessage.mockResolvedValue(undefined);
      const resolvedPaths = ['/worktrees/x/uploads/a.md', '/worktrees/x/uploads/b.png'];
      mockResolveUploadPaths.mockResolvedValue(resolvedPaths);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.send({
        sessionId: session.id,
        prompt: 'look',
        attachments: ['aaaa1111-a.md', 'bbbb2222-b.png'],
      });

      expect(result).toEqual({ success: true });
      expect(mockResolveUploadPaths).toHaveBeenCalledWith(session.id, [
        'aaaa1111-a.md',
        'bbbb2222-b.png',
      ]);
      expect(mockSendUserMessage).toHaveBeenCalledWith(session.id, 'look', resolvedPaths);
    });

    it('does not resolve attachments when none are provided', async () => {
      const session = await testPrisma.session.create({
        data: { name: 'No Attach', workspacePath: '/workspace/test', status: 'running' },
      });

      mockIsClaudeRunningAsync.mockResolvedValue(false);
      mockSendUserMessage.mockResolvedValue(undefined);

      const caller = createCaller('auth-session-id');
      await caller.claude.send({ sessionId: session.id, prompt: 'hi' });

      expect(mockResolveUploadPaths).not.toHaveBeenCalled();
      expect(mockSendUserMessage).toHaveBeenCalledWith(session.id, 'hi', []);
    });

    it('allows a send with attachments and no prompt text', async () => {
      const session = await testPrisma.session.create({
        data: { name: 'Attach Only', workspacePath: '/workspace/test', status: 'running' },
      });

      mockIsClaudeRunningAsync.mockResolvedValue(false);
      mockSendUserMessage.mockResolvedValue(undefined);
      mockResolveUploadPaths.mockResolvedValue(['/worktrees/x/uploads/a.md']);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.send({
        sessionId: session.id,
        prompt: '',
        attachments: ['aaaa1111-a.md'],
      });
      expect(result).toEqual({ success: true });
      expect(mockSendUserMessage).toHaveBeenCalledWith(session.id, '', [
        '/worktrees/x/uploads/a.md',
      ]);
    });

    it('rejects an empty prompt with no attachments', async () => {
      const session = await testPrisma.session.create({
        data: { name: 'Empty', workspacePath: '/workspace/test', status: 'running' },
      });
      const caller = createCaller('auth-session-id');
      await expect(caller.claude.send({ sessionId: session.id, prompt: '   ' })).rejects.toThrow();
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.send({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          prompt: 'Hello!',
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Session not found',
      });
    });

    it('should throw PRECONDITION_FAILED if session is not running', async () => {
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

      await expect(
        caller.claude.send({
          sessionId: session.id,
          prompt: 'Hello!',
        })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Session is not running',
      });
    });

    it('accepts a send while Claude is running (message is queued)', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Running Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      // A turn being active no longer blocks a send — sendUserMessage queues it
      // and flushes at turn end (async "btw mode").
      mockIsClaudeRunningAsync.mockResolvedValue(true);
      mockSendUserMessage.mockResolvedValue(undefined);

      const caller = createCaller('auth-session-id');

      const result = await caller.claude.send({
        sessionId: session.id,
        prompt: 'Hello!',
      });

      expect(result).toEqual({ success: true });
      expect(mockSendUserMessage).toHaveBeenCalledWith(session.id, 'Hello!', []);
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.claude.send({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          prompt: 'Hello!',
        })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });

    it('should validate prompt is not empty', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.send({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          prompt: '',
        })
      ).rejects.toThrow();
    });
  });

  describe('sendBatch', () => {
    it('resolves each message and forwards them to sendUserMessages', async () => {
      const session = await testPrisma.session.create({
        data: { name: 'Batch', workspacePath: '/workspace/test', status: 'running' },
      });

      mockSendUserMessages.mockResolvedValue(undefined);
      // First message has attachments, second has none.
      mockResolveUploadPaths.mockResolvedValue(['/worktrees/x/uploads/a.md']);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.sendBatch({
        sessionId: session.id,
        messages: [{ prompt: 'first', attachments: ['aaaa1111-a.md'] }, { prompt: 'second' }],
      });

      expect(result).toEqual({ success: true });
      expect(mockResolveUploadPaths).toHaveBeenCalledTimes(1);
      expect(mockSendUserMessages).toHaveBeenCalledWith(session.id, [
        { prompt: 'first', attachmentPaths: ['/worktrees/x/uploads/a.md'] },
        { prompt: 'second', attachmentPaths: [] },
      ]);
    });

    it('rejects an empty message list', async () => {
      const session = await testPrisma.session.create({
        data: { name: 'Empty Batch', workspacePath: '/workspace/test', status: 'running' },
      });
      const caller = createCaller('auth-session-id');
      await expect(
        caller.claude.sendBatch({ sessionId: session.id, messages: [] })
      ).rejects.toThrow();
    });

    it('throws PRECONDITION_FAILED if the session is not running', async () => {
      const session = await testPrisma.session.create({
        data: { name: 'Stopped Batch', workspacePath: '/workspace/test', status: 'stopped' },
      });
      const caller = createCaller('auth-session-id');
      await expect(
        caller.claude.sendBatch({ sessionId: session.id, messages: [{ prompt: 'hi' }] })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(mockSendUserMessages).not.toHaveBeenCalled();
    });
  });

  describe('answerQuestion (fallback path)', () => {
    // With no in-memory query parked, submitLiveToolResponse returns false, so
    // these exercise the resume fallback that runs when the runner is gone
    // (e.g. after a server restart).
    const createRunningSession = () =>
      testPrisma.session.create({
        data: {
          name: 'Q Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

    it('marks the question answered and resumes with a new turn', async () => {
      const session = await createRunningSession();
      mockIsClaudeRunningAsync.mockResolvedValue(false);
      mockSendUserMessage.mockResolvedValue(undefined);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.answerQuestion({
        sessionId: session.id,
        toolUseId: 'toolu_q1',
        answers: { 'Which approach?': 'Option A' },
      });

      expect(result).toEqual({ success: true, routed: 'fallback' });

      // A synthetic tool_result was persisted so the UI pairs the dangling block.
      const messages = await testPrisma.message.findMany({ where: { sessionId: session.id } });
      const toolResult = messages.find((m) => {
        const content = JSON.parse(m.content);
        return content.message?.content?.[0]?.tool_use_id === 'toolu_q1';
      });
      expect(toolResult).toBeDefined();

      // And the answer was resumed as a new prompt.
      expect(mockSendUserMessage).toHaveBeenCalledWith(
        session.id,
        expect.stringContaining('Option A')
      );
    });

    it('is idempotent: a duplicate answer does not start a second turn', async () => {
      const session = await createRunningSession();
      mockIsClaudeRunningAsync.mockResolvedValue(false);
      mockSendUserMessage.mockResolvedValue(undefined);

      const caller = createCaller('auth-session-id');
      const args = {
        sessionId: session.id,
        toolUseId: 'toolu_dup',
        answers: { q: 'A' },
      };

      const first = await caller.claude.answerQuestion(args);
      const second = await caller.claude.answerQuestion(args);

      expect(first.routed).toBe('fallback');
      expect(second.routed).toBe('already');
      expect(mockSendUserMessage).toHaveBeenCalledTimes(1);
    });

    it('does not drop a second answer when two tool calls are answered concurrently', async () => {
      // Two different tool_use ids answered at once race on the read-then-insert
      // sequence assignment. Both must be written (with retry) — neither should
      // be silently reported as already-answered.
      const session = await createRunningSession();
      mockIsClaudeRunningAsync.mockResolvedValue(false);
      mockSendUserMessage.mockResolvedValue(undefined);

      const caller = createCaller('auth-session-id');
      const [a, b] = await Promise.all([
        caller.claude.answerQuestion({
          sessionId: session.id,
          toolUseId: 'toolu_a',
          answers: { q: 'A' },
        }),
        caller.claude.answerQuestion({
          sessionId: session.id,
          toolUseId: 'toolu_b',
          answers: { q: 'B' },
        }),
      ]);

      expect(a.routed).toBe('fallback');
      expect(b.routed).toBe('fallback');

      const messages = await testPrisma.message.findMany({ where: { sessionId: session.id } });
      const toolUseIds = messages
        .map((m) => JSON.parse(m.content).message?.content?.[0]?.tool_use_id)
        .filter(Boolean);
      expect(toolUseIds).toContain('toolu_a');
      expect(toolUseIds).toContain('toolu_b');

      // Sequences must be unique (no collision survived).
      const sequences = messages.map((m) => m.sequence);
      expect(new Set(sequences).size).toBe(sequences.length);
      expect(mockSendUserMessage).toHaveBeenCalledTimes(2);
    });

    it('throws CONFLICT when a query is still processing', async () => {
      const session = await createRunningSession();
      mockIsClaudeRunningAsync.mockResolvedValue(true);

      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.answerQuestion({
          sessionId: session.id,
          toolUseId: 'toolu_busy',
          answers: { q: 'A' },
        })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(mockSendUserMessage).not.toHaveBeenCalled();
    });

    it('throws PRECONDITION_FAILED when the session is not running', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Stopped Q Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'stopped',
        },
      });

      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.answerQuestion({
          sessionId: session.id,
          toolUseId: 'toolu_stopped',
          answers: { q: 'A' },
        })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    });
  });

  describe('respondToPlan (fallback path)', () => {
    it('resumes with a revise prompt when changes are requested', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Plan Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });
      mockIsClaudeRunningAsync.mockResolvedValue(false);
      mockSendUserMessage.mockResolvedValue(undefined);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.respondToPlan({
        sessionId: session.id,
        toolUseId: 'toolu_plan',
        approve: false,
        feedback: 'use a queue',
      });

      expect(result).toEqual({ success: true, routed: 'fallback' });
      expect(mockSendUserMessage).toHaveBeenCalledWith(
        session.id,
        expect.stringContaining('use a queue')
      );
    });
  });

  describe('interrupt', () => {
    it('should interrupt Claude successfully', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Running Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      mockInterruptClaude.mockResolvedValue(true);
      mockMarkLastMessageAsInterrupted.mockResolvedValue(undefined);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.interrupt({ sessionId: session.id });

      expect(result).toEqual({ success: true });
      expect(mockInterruptClaude).toHaveBeenCalledWith(session.id);
      expect(mockMarkLastMessageAsInterrupted).toHaveBeenCalledWith(session.id);
    });

    it('should return false if no process to interrupt', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Idle Session',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      mockInterruptClaude.mockResolvedValue(false);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.interrupt({ sessionId: session.id });

      expect(result).toEqual({ success: false });
      expect(mockMarkLastMessageAsInterrupted).not.toHaveBeenCalled();
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.interrupt({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.claude.interrupt({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('getHistory', () => {
    it('should get message history from the database', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Session with history',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      // Create messages in the database
      await testPrisma.message.createMany({
        data: [
          {
            sessionId: session.id,
            sequence: 0,
            type: 'user',
            content: '{"type":"user","content":"Hello"}',
          },
          {
            sessionId: session.id,
            sequence: 1,
            type: 'assistant',
            content: '{"type":"assistant","content":"Hi there!"}',
          },
          {
            sessionId: session.id,
            sequence: 2,
            type: 'user',
            content: '{"type":"user","content":"How are you?"}',
          },
        ],
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.getHistory({ sessionId: session.id });

      expect(result.messages).toHaveLength(3);
      expect(result.hasMore).toBe(false);

      // Messages should be in chronological order
      expect(result.messages[0].sequence).toBe(0);
      expect(result.messages[0].content).toEqual({ type: 'user', content: 'Hello' });
      expect(result.messages[1].sequence).toBe(1);
      expect(result.messages[2].sequence).toBe(2);
    });

    it('should support backward pagination', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Session with many messages',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      // Create 60 messages
      const messages = Array.from({ length: 60 }, (_, i) => ({
        sessionId: session.id,
        sequence: i,
        type: i % 2 === 0 ? 'user' : 'assistant',
        content: JSON.stringify({ type: i % 2 === 0 ? 'user' : 'assistant', seq: i }),
      }));
      await testPrisma.message.createMany({ data: messages });

      const caller = createCaller('auth-session-id');

      // Get messages before sequence 50
      const result = await caller.claude.getHistory({
        sessionId: session.id,
        cursor: { sequence: 50, direction: 'backward' },
        limit: 20,
      });

      expect(result.messages).toHaveLength(20);
      expect(result.hasMore).toBe(true);
      // Should be sequences 30-49 in chronological order
      expect(result.messages[0].sequence).toBe(30);
      expect(result.messages[19].sequence).toBe(49);
    });

    it('should support forward pagination', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Session with messages',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      // Create 20 messages
      const messages = Array.from({ length: 20 }, (_, i) => ({
        sessionId: session.id,
        sequence: i,
        type: 'user',
        content: JSON.stringify({ type: 'user', seq: i }),
      }));
      await testPrisma.message.createMany({ data: messages });

      const caller = createCaller('auth-session-id');

      // Get messages after sequence 10
      const result = await caller.claude.getHistory({
        sessionId: session.id,
        cursor: { sequence: 10, direction: 'forward' },
        limit: 50,
      });

      expect(result.messages).toHaveLength(9); // sequences 11-19
      expect(result.hasMore).toBe(false);
      expect(result.messages[0].sequence).toBe(11);
      expect(result.messages[8].sequence).toBe(19);
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.getHistory({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.claude.getHistory({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('isRunning', () => {
    it('should return running status', async () => {
      mockIsClaudeRunningAsync.mockResolvedValue(true);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.isRunning({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result).toEqual({ running: true });
    });

    it('should return not running status', async () => {
      mockIsClaudeRunningAsync.mockResolvedValue(false);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.isRunning({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result).toEqual({ running: false });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.claude.isRunning({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('getTokenUsage', () => {
    it('should calculate token usage from messages in the database', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Session with usage',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      // Create a result message with usage data
      await testPrisma.message.create({
        data: {
          sessionId: session.id,
          sequence: 0,
          type: 'result',
          content: JSON.stringify({
            type: 'result',
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
              cache_read_input_tokens: 100,
              cache_creation_input_tokens: 50,
            },
          }),
        },
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.getTokenUsage({ sessionId: session.id });

      // Uses real token estimation
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
      expect(result.cacheReadTokens).toBe(100);
      expect(result.cacheCreationTokens).toBe(50);
      expect(result.totalTokens).toBe(1500);
    });

    it('should aggregate usage from multiple result messages', async () => {
      const session = await testPrisma.session.create({
        data: {
          name: 'Session with multiple turns',
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          workspacePath: '/workspace/test',
          status: 'running',
        },
      });

      // Create multiple result messages (each turn)
      await testPrisma.message.createMany({
        data: [
          {
            sessionId: session.id,
            sequence: 0,
            type: 'result',
            content: JSON.stringify({
              type: 'result',
              usage: { input_tokens: 1000, output_tokens: 500 },
            }),
          },
          {
            sessionId: session.id,
            sequence: 1,
            type: 'result',
            content: JSON.stringify({
              type: 'result',
              usage: { input_tokens: 2000, output_tokens: 800 },
            }),
          },
        ],
      });

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.getTokenUsage({ sessionId: session.id });

      expect(result.inputTokens).toBe(3000);
      expect(result.outputTokens).toBe(1300);
      expect(result.totalTokens).toBe(4300);
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.getTokenUsage({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.claude.getTokenUsage({ sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });
});
