import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Create mock objects that will be hoisted
const { mockPodmanFunctions, mockPrisma, mockSseEvents, mockAgentClient } = vi.hoisted(() => {
  const mockPodmanFunctions = {
    getContainerStatus: vi.fn(),
    getContainerState: vi.fn(),
    getContainerLogs: vi.fn(),
    describeExitCode: vi.fn((code: number | null) => {
      if (code === null) return 'unknown exit code';
      if (code === 0) return 'success';
      if (code === 137) return 'killed (SIGKILL) - possibly out of memory';
      return `error code ${code}`;
    }),
  };

  const mockPrisma = {
    session: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    message: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };

  const mockSseEvents = {
    emitNewMessage: vi.fn(),
    emitClaudeRunning: vi.fn(),
    emitCommands: vi.fn(),
    emitSessionUpdate: vi.fn(),
    emitPrUpdate: vi.fn(),
  };

  const mockAgentClient = {
    query: vi.fn(),
    interrupt: vi.fn(),
    getStatus: vi.fn(),
    getMessages: vi.fn(),
    getCommands: vi.fn(),
    getCurrentBranch: vi.fn(),
    health: vi.fn(),
  };

  return { mockPodmanFunctions, mockPrisma, mockSseEvents, mockAgentClient };
});

// Mock the podman service
vi.mock('./podman', () => mockPodmanFunctions);

// Mock prisma
vi.mock('@/lib/prisma', () => ({
  prisma: mockPrisma,
}));

// Mock the events module
vi.mock('./events', () => ({
  sseEvents: mockSseEvents,
}));

// Mock the github service
const mockFetchPullRequestForBranch = vi.fn();
vi.mock('./github', () => ({
  fetchPullRequestForBranch: (...args: unknown[]) => mockFetchPullRequestForBranch(...args),
}));

// Mock the logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));

// Mock uuid to return predictable values
let uuidCounter = 0;
vi.mock('uuid', () => ({
  v4: () => `test-uuid-${++uuidCounter}`,
  v5: (content: string, namespace: string) => `v5-${content.slice(0, 20)}-${namespace.slice(0, 8)}`,
}));

// Mock agent-client
vi.mock('./agent-client', () => ({
  createAgentClient: () => mockAgentClient,
  getAgentSocketPath: (sessionId: string) => `/sockets/${sessionId}.sock`,
  waitForAgentHealth: vi.fn().mockResolvedValue(true),
}));

// Import after mocks are set up
import {
  runClaudeCommand,
  interruptClaude,
  isClaudeRunning,
  isClaudeRunningAsync,
  markLastMessageAsInterrupted,
  reconcileOrphanedProcesses,
  buildSystemPrompt,
  shouldAutoInterrupt,
  DEFAULT_SYSTEM_PROMPT,
} from './claude-runner';

describe('claude-runner service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;

    // Reset default mock implementations
    mockPrisma.session.findUnique.mockResolvedValue(null);
    mockPrisma.session.findMany.mockResolvedValue([]);
    mockPrisma.session.update.mockImplementation(({ data, where }) =>
      Promise.resolve({ id: where.id, ...data })
    );
    mockPrisma.message.findUnique.mockResolvedValue(null);
    mockPrisma.message.findFirst.mockResolvedValue(null);
    mockPrisma.message.create.mockImplementation(({ data }) => Promise.resolve(data));
    mockPrisma.message.update.mockResolvedValue({});

    mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
    mockPodmanFunctions.getContainerState.mockResolvedValue({
      status: 'running',
      exitCode: 0,
      error: null,
      startedAt: '2024-01-01T00:00:00Z',
      finishedAt: null,
      oomKilled: false,
    });
    mockPodmanFunctions.getContainerLogs.mockResolvedValue(null);

    mockAgentClient.health.mockResolvedValue(true);
    mockAgentClient.getStatus.mockResolvedValue({ running: false, lastSequence: 0, commands: [] });
    mockAgentClient.interrupt.mockResolvedValue({ success: true });
    mockAgentClient.getMessages.mockResolvedValue([]);
    mockAgentClient.getCurrentBranch.mockResolvedValue(null);
    mockFetchPullRequestForBranch.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('buildSystemPrompt', () => {
    it('should return default prompt when no options provided', () => {
      const result = buildSystemPrompt({});
      expect(result).toBe(DEFAULT_SYSTEM_PROMPT);
    });

    it('should use global override when enabled', () => {
      const override = 'Custom override prompt';
      const result = buildSystemPrompt({
        globalSettings: {
          systemPromptOverride: override,
          systemPromptOverrideEnabled: true,
          systemPromptAppend: null,
        },
      });
      expect(result).toBe(override);
      expect(result).not.toContain('CONTAINER ISSUE REPORTING');
    });

    it('should use default when global override is disabled', () => {
      const result = buildSystemPrompt({
        globalSettings: {
          systemPromptOverride: 'Should not be used',
          systemPromptOverrideEnabled: false,
          systemPromptAppend: null,
        },
      });
      expect(result).toBe(DEFAULT_SYSTEM_PROMPT);
    });

    it('should append global append content after base prompt', () => {
      const appendContent = 'Always prefer functional programming.';
      const result = buildSystemPrompt({
        globalSettings: {
          systemPromptOverride: null,
          systemPromptOverrideEnabled: false,
          systemPromptAppend: appendContent,
        },
      });
      expect(result).toContain(DEFAULT_SYSTEM_PROMPT);
      expect(result).toContain(appendContent);
    });

    it('should append per-repo custom prompt', () => {
      const customPrompt = 'Always use TypeScript strict mode.';
      const result = buildSystemPrompt({ customSystemPrompt: customPrompt });
      expect(result).toContain(DEFAULT_SYSTEM_PROMPT);
      expect(result).toContain(customPrompt);
    });

    it('should combine global override, global append, and per-repo prompt in order', () => {
      const override = 'OVERRIDE BASE';
      const append = 'GLOBAL APPEND';
      const repo = 'REPO SPECIFIC';

      const result = buildSystemPrompt({
        customSystemPrompt: repo,
        globalSettings: {
          systemPromptOverride: override,
          systemPromptOverrideEnabled: true,
          systemPromptAppend: append,
        },
      });

      expect(result).toContain(override);
      expect(result).toContain(append);
      expect(result).toContain(repo);

      const overrideIndex = result.indexOf(override);
      const appendIndex = result.indexOf(append);
      const repoIndex = result.indexOf(repo);
      expect(overrideIndex).toBeLessThan(appendIndex);
      expect(appendIndex).toBeLessThan(repoIndex);
    });

    it('should not append anything when customSystemPrompt is null', () => {
      const result = buildSystemPrompt({ customSystemPrompt: null });
      expect(result).toBe(DEFAULT_SYSTEM_PROMPT);
    });
  });

  describe('interruptClaude', () => {
    it('should return false if session has no container', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        containerId: null,
      });

      const result = await interruptClaude('test-session-no-container');
      expect(result).toBe(false);
    });

    it('should call agent client interrupt when session has container', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        containerId: 'container-123',
      });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');

      const result = await interruptClaude('test-session-with-container');
      expect(result).toBe(true);
      expect(mockAgentClient.interrupt).toHaveBeenCalled();
    });

    it('should return false when container is not running', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        containerId: 'container-123',
      });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('stopped');

      const result = await interruptClaude('test-session-stopped');
      expect(result).toBe(false);
    });

    it('should return false when interrupt fails', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        containerId: 'container-123',
      });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.interrupt.mockRejectedValue(new Error('Agent unreachable'));

      const result = await interruptClaude('test-session-fail');
      expect(result).toBe(false);
    });
  });

  describe('isClaudeRunning', () => {
    it('should return false when no query is active in memory', () => {
      const result = isClaudeRunning('unique-nonexistent-session');
      expect(result).toBe(false);
    });
  });

  describe('isClaudeRunningAsync', () => {
    it('should return false when session has no container', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        containerId: null,
      });

      const result = await isClaudeRunningAsync('test-session-no-container');
      expect(result).toBe(false);
    });

    it('should return false when container is not running', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        containerId: 'container-123',
      });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('stopped');

      const result = await isClaudeRunningAsync('test-session-stopped');
      expect(result).toBe(false);
    });

    it('should return true when agent reports running', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        containerId: 'container-123',
      });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.getStatus.mockResolvedValue({ running: true, lastSequence: 5, commands: [] });

      const result = await isClaudeRunningAsync('test-session-running');
      expect(result).toBe(true);
    });

    it('should return false when agent reports not running', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        containerId: 'container-123',
      });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.getStatus.mockResolvedValue({
        running: false,
        lastSequence: 0,
        commands: [],
      });

      const result = await isClaudeRunningAsync('test-session-idle');
      expect(result).toBe(false);
    });

    it('should return false when agent is unreachable', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        containerId: 'container-123',
      });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.getStatus.mockRejectedValue(new Error('Connection refused'));

      const result = await isClaudeRunningAsync('test-session-unreachable');
      expect(result).toBe(false);
    });
  });

  describe('markLastMessageAsInterrupted', () => {
    it('should do nothing if no messages exist', async () => {
      mockPrisma.message.findFirst.mockResolvedValue(null);

      await markLastMessageAsInterrupted('test-session-no-msgs');

      expect(mockPrisma.message.update).not.toHaveBeenCalled();
    });

    it('should mark last non-user message as interrupted and create interrupt message', async () => {
      const lastMessage = {
        id: 'last-msg',
        sequence: 5,
        type: 'user',
        content: '{"type": "user"}',
      };
      const lastNonUserMessage = {
        id: 'assistant-msg',
        sequence: 4,
        type: 'assistant',
        content: JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [] },
        }),
      };

      mockPrisma.message.findFirst
        .mockResolvedValueOnce(lastMessage)
        .mockResolvedValueOnce(lastNonUserMessage);

      await markLastMessageAsInterrupted('test-session-interrupt');

      expect(mockPrisma.message.update).toHaveBeenCalledWith({
        where: { id: 'assistant-msg' },
        data: {
          content: expect.stringContaining('"interrupted":true'),
        },
      });

      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sessionId: 'test-session-interrupt',
          sequence: 6,
          type: 'user',
          content: expect.stringContaining('"subtype":"interrupt"'),
        }),
      });

      expect(mockSseEvents.emitNewMessage).toHaveBeenCalled();
    });

    it('should still create interrupt message even if no non-user message exists', async () => {
      const lastMessage = {
        id: 'last-msg',
        sequence: 5,
        type: 'user',
        content: '{"type": "user"}',
      };

      mockPrisma.message.findFirst.mockResolvedValueOnce(lastMessage).mockResolvedValueOnce(null);

      await markLastMessageAsInterrupted('test-session-no-non-user');

      expect(mockPrisma.message.update).not.toHaveBeenCalled();
      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sessionId: 'test-session-no-non-user',
          type: 'user',
          content: expect.stringContaining('"subtype":"interrupt"'),
        }),
      });
    });

    it('should handle JSON parse errors gracefully', async () => {
      const lastMessage = {
        id: 'last-msg',
        sequence: 5,
        type: 'assistant',
        content: 'not valid json',
      };
      const lastNonUserMessage = {
        id: 'assistant-msg',
        sequence: 4,
        type: 'assistant',
        content: 'also not valid json',
      };

      mockPrisma.message.findFirst
        .mockResolvedValueOnce(lastMessage)
        .mockResolvedValueOnce(lastNonUserMessage);

      await markLastMessageAsInterrupted('test-session-parse-error');

      expect(mockPrisma.message.create).toHaveBeenCalled();
    });
  });

  describe('reconcileOrphanedProcesses', () => {
    it('should return counts when no running sessions exist', async () => {
      mockPrisma.session.findMany.mockResolvedValue([]);

      const result = await reconcileOrphanedProcesses();

      expect(result).toEqual({ total: 0, reconnected: 0, cleaned: 0 });
    });

    it('should clean up sessions with stopped containers', async () => {
      mockPrisma.session.findMany.mockResolvedValue([
        {
          id: 'session-1',
          agentPort: 10000,
          containerId: 'container-1',
        },
      ]);
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('stopped');
      mockPodmanFunctions.getContainerState.mockResolvedValue({
        status: 'stopped',
        exitCode: 1,
        error: 'container exited',
        startedAt: '2024-01-01T00:00:00Z',
        finishedAt: '2024-01-01T00:01:00Z',
        oomKilled: false,
      });

      const result = await reconcileOrphanedProcesses();

      expect(result).toEqual({ total: 1, reconnected: 0, cleaned: 1 });
    });

    it('should reconnect sessions with healthy agent service', async () => {
      mockPrisma.session.findMany.mockResolvedValue([
        {
          id: 'session-1',
          containerId: 'container-1',
        },
      ]);
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.getStatus.mockResolvedValue({
        running: false,
        lastSequence: 0,
        commands: [],
      });

      const result = await reconcileOrphanedProcesses();

      expect(result).toEqual({ total: 1, reconnected: 1, cleaned: 0 });
    });

    it('should handle errors during reconciliation', async () => {
      mockPrisma.session.findMany.mockResolvedValue([
        {
          id: 'session-error',
          containerId: 'container-1',
        },
      ]);
      mockPodmanFunctions.getContainerStatus.mockRejectedValue(new Error('Podman error'));

      const result = await reconcileOrphanedProcesses();

      expect(result).toEqual({ total: 1, reconnected: 0, cleaned: 1 });
    });

    it('should process multiple sessions', async () => {
      mockPrisma.session.findMany.mockResolvedValue([
        { id: 'session-1', containerId: 'container-1' },
        { id: 'session-2', containerId: 'container-2' },
      ]);
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.getStatus.mockResolvedValue({
        running: false,
        lastSequence: 0,
        commands: [],
      });

      const result = await reconcileOrphanedProcesses();

      expect(result).toEqual({ total: 2, reconnected: 2, cleaned: 0 });
    });
  });

  describe('runClaudeCommand', () => {
    it('should throw error if container is not running', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ repoPath: 'my-repo' });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('stopped');

      await expect(
        runClaudeCommand({
          sessionId: 'test-session',
          containerId: 'container-1',
          prompt: 'Hello',
        })
      ).rejects.toThrow('Cannot execute Claude command: container is stopped');
    });

    it('should throw error if agent service is not healthy', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ repoPath: 'my-repo' });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.health.mockResolvedValue(false);

      await expect(
        runClaudeCommand({
          sessionId: 'test-session',
          containerId: 'container-1',
          prompt: 'Hello',
        })
      ).rejects.toThrow('Agent service is not healthy');
    });

    it('should throw error if agent already has a running query', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ repoPath: 'my-repo' });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.health.mockResolvedValue(true);
      mockAgentClient.getStatus.mockResolvedValue({ running: true, lastSequence: 5, commands: [] });

      await expect(
        runClaudeCommand({
          sessionId: 'test-session',
          containerId: 'container-1',
          prompt: 'Hello',
        })
      ).rejects.toThrow('A Claude process is already running for this session');
    });

    it('should save user message before starting query', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ repoPath: 'my-repo' });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.health.mockResolvedValue(true);
      mockAgentClient.getStatus.mockResolvedValue({
        running: false,
        lastSequence: 0,
        commands: [],
      });

      // Return empty async generator
      mockAgentClient.query.mockReturnValue(
        (async function* () {
          // no messages
        })()
      );

      await runClaudeCommand({
        sessionId: 'test-session',
        containerId: 'container-1',
        prompt: 'Hello Claude',
      });

      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sessionId: 'test-session',
          type: 'user',
          content: expect.stringContaining('Hello Claude'),
        }),
      });
    });

    it('should emit SSE events for user message and Claude running state', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ repoPath: 'my-repo' });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.health.mockResolvedValue(true);
      mockAgentClient.getStatus.mockResolvedValue({
        running: false,
        lastSequence: 0,
        commands: [],
      });

      mockAgentClient.query.mockReturnValue(
        (async function* () {
          // no messages
        })()
      );

      await runClaudeCommand({
        sessionId: 'test-session',
        containerId: 'container-1',
        prompt: 'Hello',
      });

      expect(mockSseEvents.emitNewMessage).toHaveBeenCalledWith(
        'test-session',
        expect.objectContaining({ type: 'user' })
      );
      expect(mockSseEvents.emitClaudeRunning).toHaveBeenCalledWith('test-session', true);
      expect(mockSseEvents.emitClaudeRunning).toHaveBeenCalledWith('test-session', false);
    });

    it('should save and emit streamed messages from agent', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ repoPath: 'my-repo' });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.health.mockResolvedValue(true);
      mockAgentClient.getStatus.mockResolvedValue({
        running: false,
        lastSequence: 0,
        commands: [],
      });

      const assistantMessage = {
        type: 'assistant',
        uuid: 'assistant-uuid-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello! How can I help?' }],
        },
      };

      mockAgentClient.query.mockReturnValue(
        (async function* () {
          yield { sequence: 1, message: assistantMessage };
        })()
      );

      await runClaudeCommand({
        sessionId: 'test-session',
        containerId: 'container-1',
        prompt: 'Hello',
      });

      // Should save assistant message (in addition to user message)
      expect(mockPrisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'assistant-uuid-1',
          sessionId: 'test-session',
          type: 'assistant',
        }),
      });
    });

    it('should handle duplicate messages gracefully', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ repoPath: 'my-repo' });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.health.mockResolvedValue(true);
      mockAgentClient.getStatus.mockResolvedValue({
        running: false,
        lastSequence: 0,
        commands: [],
      });

      const agentMessage = {
        type: 'assistant',
        uuid: 'dup-uuid',
        message: { role: 'assistant', content: [] },
      };

      mockAgentClient.query.mockReturnValue(
        (async function* () {
          yield { sequence: 1, message: agentMessage };
        })()
      );

      // First create succeeds (user message), second fails with unique constraint
      mockPrisma.message.create
        .mockResolvedValueOnce({ id: 'test-uuid-1' }) // user message
        .mockRejectedValueOnce({ code: 'P2002' }); // duplicate

      // Should not throw
      await runClaudeCommand({
        sessionId: 'test-session',
        containerId: 'container-1',
        prompt: 'Hello',
      });
    });

    it('should clean up and report errors on query failure', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ repoPath: 'my-repo' });
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.health.mockResolvedValue(true);
      mockAgentClient.getStatus.mockResolvedValue({
        running: false,
        lastSequence: 0,
        commands: [],
      });

      mockAgentClient.query.mockReturnValue(
        (async function* () {
          throw new Error('Connection lost');
        })()
      );

      // Should not throw (error is handled internally)
      await runClaudeCommand({
        sessionId: 'test-session',
        containerId: 'container-1',
        prompt: 'Hello',
      });

      // Should emit running=false
      expect(mockSseEvents.emitClaudeRunning).toHaveBeenCalledWith('test-session', false);
    });

    it('should use resume=false when agent has no prior messages (fresh container)', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ repoPath: 'my-repo' });
      mockPrisma.message.findFirst.mockResolvedValue(null); // no existing messages
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.health.mockResolvedValue(true);
      mockAgentClient.getStatus.mockResolvedValue({
        running: false,
        lastSequence: 0,
        commands: [],
      });

      mockAgentClient.query.mockReturnValue(
        (async function* () {
          // no messages
        })()
      );

      await runClaudeCommand({
        sessionId: 'test-session',
        containerId: 'container-1',
        prompt: 'First message',
      });

      expect(mockAgentClient.query).toHaveBeenCalledWith(
        expect.objectContaining({
          resume: false,
          prompt: 'First message',
        })
      );
    });

    it('should use resume=false after container restart even with DB messages', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ repoPath: 'my-repo' });
      mockPrisma.message.findFirst.mockResolvedValue({ sequence: 5 }); // DB has messages from previous run
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.health.mockResolvedValue(true);
      // Agent has lastSequence: 0 (fresh container, no prior messages in agent)
      mockAgentClient.getStatus.mockResolvedValue({
        running: false,
        lastSequence: 0,
        commands: [],
      });

      mockAgentClient.query.mockReturnValue(
        (async function* () {
          // no messages
        })()
      );

      await runClaudeCommand({
        sessionId: 'test-session',
        containerId: 'container-1',
        prompt: 'Follow-up after restart',
      });

      expect(mockAgentClient.query).toHaveBeenCalledWith(
        expect.objectContaining({
          resume: false,
          prompt: 'Follow-up after restart',
        })
      );
    });

    it('should use resume=true when agent has prior messages', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ repoPath: 'my-repo' });
      mockPrisma.message.findFirst.mockResolvedValue({ sequence: 5 }); // has existing messages
      mockPodmanFunctions.getContainerStatus.mockResolvedValue('running');
      mockAgentClient.health.mockResolvedValue(true);
      // Agent has lastSequence: 3 (has prior messages from an earlier query in same container lifecycle)
      mockAgentClient.getStatus.mockResolvedValue({
        running: false,
        lastSequence: 3,
        commands: [],
      });

      mockAgentClient.query.mockReturnValue(
        (async function* () {
          // no messages
        })()
      );

      await runClaudeCommand({
        sessionId: 'test-session',
        containerId: 'container-1',
        prompt: 'Follow-up in same session',
      });

      expect(mockAgentClient.query).toHaveBeenCalledWith(
        expect.objectContaining({
          resume: true,
          prompt: 'Follow-up in same session',
        })
      );
    });
  });
});

describe('claude-runner system prompt', () => {
  it('should contain instructions for remote user workflow', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('commit');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('push');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Pull Request');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('CONTAINER ISSUE REPORTING');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('clawed-abode');
  });
});

describe('shouldAutoInterrupt', () => {
  it('should return true for AskUserQuestion tool call', () => {
    const message = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'test-id',
            name: 'AskUserQuestion',
            input: { questions: [] },
          },
        ],
      },
    };
    expect(shouldAutoInterrupt(message)).toBe(true);
  });

  it('should return true for ExitPlanMode tool call', () => {
    const message = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'test-id',
            name: 'ExitPlanMode',
            input: {},
          },
        ],
      },
    };
    expect(shouldAutoInterrupt(message)).toBe(true);
  });

  it('should return false for regular tool calls', () => {
    const message = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'test-id',
            name: 'Write',
            input: { file_path: '/tmp/test.txt', content: 'hello' },
          },
        ],
      },
    };
    expect(shouldAutoInterrupt(message)).toBe(false);
  });

  it('should return false for text-only assistant messages', () => {
    const message = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello, how can I help?' }],
      },
    };
    expect(shouldAutoInterrupt(message)).toBe(false);
  });

  it('should return false for user messages', () => {
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    };
    expect(shouldAutoInterrupt(message)).toBe(false);
  });

  it('should return false for null/undefined', () => {
    expect(shouldAutoInterrupt(null)).toBe(false);
    expect(shouldAutoInterrupt(undefined)).toBe(false);
  });

  it('should return true when AskUserQuestion is mixed with other tool calls', () => {
    const message = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me ask a question' },
          {
            type: 'tool_use',
            id: 'test-id',
            name: 'AskUserQuestion',
            input: { questions: [] },
          },
        ],
      },
    };
    expect(shouldAutoInterrupt(message)).toBe(true);
  });
});
