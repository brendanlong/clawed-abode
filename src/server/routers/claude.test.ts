import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Prisma with vi.hoisted
const mockPrisma = vi.hoisted(() => ({
  session: {
    findUnique: vi.fn(),
  },
  message: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: mockPrisma,
}));

// Mock claude-runner service with vi.hoisted
const mockRunClaudeCommand = vi.hoisted(() => vi.fn());
const mockInterruptClaude = vi.hoisted(() => vi.fn());
const mockIsClaudeRunningAsync = vi.hoisted(() => vi.fn());
const mockMarkLastMessageAsInterrupted = vi.hoisted(() => vi.fn());

vi.mock('../services/claude-runner', () => ({
  runClaudeCommand: mockRunClaudeCommand,
  interruptClaude: mockInterruptClaude,
  isClaudeRunningAsync: mockIsClaudeRunningAsync,
  markLastMessageAsInterrupted: mockMarkLastMessageAsInterrupted,
}));

// Mock token estimation with vi.hoisted
const mockEstimateTokenUsage = vi.hoisted(() => vi.fn());

vi.mock('@/lib/token-estimation', () => ({
  estimateTokenUsage: mockEstimateTokenUsage,
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
import { claudeRouter } from './claude';
import { router } from '../trpc';

// Create a test caller with proper context
const createCaller = (sessionId: string | null) => {
  const testRouter = router({
    claude: claudeRouter,
  });
  return testRouter.createCaller({ sessionId });
};

describe('claudeRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('send', () => {
    it('should send a prompt to Claude', async () => {
      const mockSession = {
        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        status: 'running',
        containerId: 'container-id',
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);
      mockIsClaudeRunningAsync.mockResolvedValue(false);
      mockRunClaudeCommand.mockResolvedValue(undefined);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.send({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        prompt: 'Hello, Claude!',
      });

      expect(result).toEqual({ success: true });
      expect(mockRunClaudeCommand).toHaveBeenCalledWith(
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        'container-id',
        'Hello, Claude!'
      );
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);

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
      const mockSession = {
        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        status: 'stopped',
        containerId: null,
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);

      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.send({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          prompt: 'Hello!',
        })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Session is not running',
      });
    });

    it('should throw CONFLICT if Claude is already running', async () => {
      const mockSession = {
        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        status: 'running',
        containerId: 'container-id',
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);
      mockIsClaudeRunningAsync.mockResolvedValue(true);

      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.send({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          prompt: 'Hello!',
        })
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'Claude is already running for this session',
      });
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

    it('should validate prompt length', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.send({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          prompt: '',
        })
      ).rejects.toThrow();
    });
  });

  describe('interrupt', () => {
    it('should interrupt Claude successfully', async () => {
      const mockSession = {
        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        status: 'running',
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);
      mockInterruptClaude.mockResolvedValue(true);
      mockMarkLastMessageAsInterrupted.mockResolvedValue(undefined);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.interrupt({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result).toEqual({ success: true });
      expect(mockInterruptClaude).toHaveBeenCalledWith('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
      expect(mockMarkLastMessageAsInterrupted).toHaveBeenCalledWith(
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
      );
    });

    it('should return false if no process to interrupt', async () => {
      const mockSession = {
        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        status: 'running',
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);
      mockInterruptClaude.mockResolvedValue(false);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.interrupt({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result).toEqual({ success: false });
      expect(mockMarkLastMessageAsInterrupted).not.toHaveBeenCalled();
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);

      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.interrupt({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.claude.interrupt({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('getHistory', () => {
    it('should get message history without cursor', async () => {
      const mockSession = {
        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      };

      // Without cursor, newest are fetched first (orderBy: desc) then reversed for chronological order
      // So mock data should be in desc order (newest first)
      const mockMessages = [
        {
          id: 'msg-2',
          sessionId: mockSession.id,
          sequence: 1,
          type: 'assistant',
          content: '{"type":"assistant"}',
        },
        {
          id: 'msg-1',
          sessionId: mockSession.id,
          sequence: 0,
          type: 'user',
          content: '{"type":"user"}',
        },
      ];

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);
      mockPrisma.message.findMany.mockResolvedValue(mockMessages);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.getHistory({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result.messages).toHaveLength(2);
      expect(result.hasMore).toBe(false);
      // Content should be parsed and in chronological order (oldest first after reversal)
      expect(result.messages[0].content).toEqual({ type: 'user' });
      expect(result.messages[1].content).toEqual({ type: 'assistant' });
    });

    it('should support backward pagination', async () => {
      const mockSession = {
        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      };

      // Return limit + 1 to indicate hasMore
      const mockMessages = Array.from({ length: 51 }, (_, i) => ({
        id: `msg-${i}`,
        sessionId: mockSession.id,
        sequence: 100 - i,
        type: 'assistant',
        content: '{"type":"assistant"}',
      }));

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);
      mockPrisma.message.findMany.mockResolvedValue(mockMessages);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.getHistory({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        cursor: { sequence: 100, direction: 'backward' },
        limit: 50,
      });

      expect(result.hasMore).toBe(true);
      expect(result.messages).toHaveLength(50);
      expect(mockPrisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
            sequence: { lt: 100 },
          },
          orderBy: { sequence: 'desc' },
          take: 51,
        })
      );
    });

    it('should support forward pagination', async () => {
      const mockSession = {
        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      };

      const mockMessages = [
        {
          id: 'msg-1',
          sessionId: mockSession.id,
          sequence: 6,
          type: 'assistant',
          content: '{"type":"assistant"}',
        },
        {
          id: 'msg-2',
          sessionId: mockSession.id,
          sequence: 7,
          type: 'assistant',
          content: '{"type":"assistant"}',
        },
      ];

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);
      mockPrisma.message.findMany.mockResolvedValue(mockMessages);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.getHistory({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        cursor: { sequence: 5, direction: 'forward' },
        limit: 50,
      });

      expect(result.messages).toHaveLength(2);
      expect(mockPrisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
            sequence: { gt: 5 },
          },
          orderBy: { sequence: 'asc' },
          take: 51,
        })
      );
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);

      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.getHistory({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.claude.getHistory({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
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
        caller.claude.isRunning({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('getTokenUsage', () => {
    it('should return token usage stats', async () => {
      const mockSession = {
        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      };

      const mockMessages = [
        { type: 'result', content: '{"type":"result","usage":{}}' },
        { type: 'system', content: '{"type":"system","subtype":"init"}' },
      ];

      const mockUsage = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 100,
        cacheCreationTokens: 50,
        totalTokens: 1500,
        contextWindow: 200000,
        percentUsed: 0.75,
      };

      mockPrisma.session.findUnique.mockResolvedValue(mockSession);
      mockPrisma.message.findMany.mockResolvedValue(mockMessages);
      mockEstimateTokenUsage.mockReturnValue(mockUsage);

      const caller = createCaller('auth-session-id');
      const result = await caller.claude.getTokenUsage({
        sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });

      expect(result).toEqual(mockUsage);
      expect(mockEstimateTokenUsage).toHaveBeenCalledWith([
        { type: 'result', content: { type: 'result', usage: {} } },
        { type: 'system', content: { type: 'system', subtype: 'init' } },
      ]);
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);

      const caller = createCaller('auth-session-id');

      await expect(
        caller.claude.getTokenUsage({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.claude.getTokenUsage({
          sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });
});
