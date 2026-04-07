import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const mockPrisma = vi.hoisted(() => ({
  session: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  message: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: mockPrisma,
}));

vi.mock('./events', () => ({
  sseEvents: {
    emitNewMessage: vi.fn(),
    emitClaudeRunning: vi.fn(),
    emitCommands: vi.fn(),
    emitSessionUpdate: vi.fn(),
    emitPrUpdate: vi.fn(),
  },
}));

vi.mock('./github', () => ({
  fetchPullRequestForBranch: vi.fn(),
}));

vi.mock('./worktree-manager', () => ({
  getCurrentBranch: vi.fn().mockResolvedValue(null),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import {
  buildSystemPrompt,
  answerUserInput,
  hasPendingInput,
  isClaudeRunning,
  isClaudeRunningAsync,
  markAllSessionsStopped,
  parseShellEnv,
  buildAgentEnv,
  getBaseShellEnv,
  resetBaseShellEnvCache,
} from './claude-runner';

describe('claude-runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildSystemPrompt', () => {
    it('should return default prompt when no options provided', () => {
      const prompt = buildSystemPrompt({});
      expect(prompt).toContain('commit your changes');
      expect(prompt).toContain('push your commits');
    });

    it('should use global override when enabled', () => {
      const prompt = buildSystemPrompt({
        globalSettings: {
          systemPromptOverride: 'Custom override',
          systemPromptOverrideEnabled: true,
          systemPromptAppend: null,
        },
      });
      expect(prompt).toBe('Custom override');
      expect(prompt).not.toContain('commit your changes');
    });

    it('should not use global override when disabled', () => {
      const prompt = buildSystemPrompt({
        globalSettings: {
          systemPromptOverride: 'Custom override',
          systemPromptOverrideEnabled: false,
          systemPromptAppend: null,
        },
      });
      expect(prompt).toContain('commit your changes');
      expect(prompt).not.toContain('Custom override');
    });

    it('should append global content', () => {
      const prompt = buildSystemPrompt({
        globalSettings: {
          systemPromptOverride: null,
          systemPromptOverrideEnabled: false,
          systemPromptAppend: 'Global append',
        },
      });
      expect(prompt).toContain('commit your changes');
      expect(prompt).toContain('Global append');
    });

    it('should append per-repo custom prompt', () => {
      const prompt = buildSystemPrompt({
        customSystemPrompt: 'Repo-specific prompt',
      });
      expect(prompt).toContain('commit your changes');
      expect(prompt).toContain('Repo-specific prompt');
    });

    it('should apply all three layers in order', () => {
      const prompt = buildSystemPrompt({
        customSystemPrompt: 'Repo prompt',
        globalSettings: {
          systemPromptOverride: 'Override',
          systemPromptOverrideEnabled: true,
          systemPromptAppend: 'Global append',
        },
      });
      expect(prompt).toBe('Override\n\nGlobal append\n\nRepo prompt');
    });
  });

  describe('answerUserInput', () => {
    it('should return false when no pending input exists', () => {
      const result = answerUserInput('nonexistent-session', { q: 'answer' });
      expect(result).toBe(false);
    });
  });

  describe('hasPendingInput', () => {
    it('should return false for nonexistent sessions', () => {
      expect(hasPendingInput('nonexistent-session')).toBe(false);
    });
  });

  describe('isClaudeRunning', () => {
    it('should return false for nonexistent sessions', () => {
      expect(isClaudeRunning('nonexistent-session')).toBe(false);
    });
  });

  describe('isClaudeRunningAsync', () => {
    it('should return false for nonexistent sessions', async () => {
      expect(await isClaudeRunningAsync('nonexistent-session')).toBe(false);
    });
  });

  describe('markAllSessionsStopped', () => {
    it('should update all running sessions to stopped', async () => {
      mockPrisma.session.updateMany.mockResolvedValue({ count: 3 });
      const result = await markAllSessionsStopped();
      expect(result).toBe(3);
      expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
        where: { status: 'running' },
        data: { status: 'stopped' },
      });
    });

    it('should return 0 when no running sessions exist', async () => {
      mockPrisma.session.updateMany.mockResolvedValue({ count: 0 });
      const result = await markAllSessionsStopped();
      expect(result).toBe(0);
    });
  });

  describe('parseShellEnv', () => {
    it('parses null-delimited env output', () => {
      const input = 'HOME=/home/user\0PATH=/usr/bin:/bin\0LANG=en_US.UTF-8\0';
      const result = parseShellEnv(input);
      expect(result).toEqual({
        HOME: '/home/user',
        PATH: '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
      });
    });

    it('handles values containing equals signs', () => {
      const input = 'FOO=bar=baz\0';
      const result = parseShellEnv(input);
      expect(result).toEqual({ FOO: 'bar=baz' });
    });

    it('handles empty input', () => {
      expect(parseShellEnv('')).toEqual({});
    });

    it('handles values containing newlines', () => {
      const input = 'MULTI=line1\nline2\0SIMPLE=value\0';
      const result = parseShellEnv(input);
      expect(result).toEqual({
        MULTI: 'line1\nline2',
        SIMPLE: 'value',
      });
    });

    it('skips entries without an equals sign', () => {
      const input = 'VALID=yes\0invalid\0ALSO_VALID=yep\0';
      const result = parseShellEnv(input);
      expect(result).toEqual({
        VALID: 'yes',
        ALSO_VALID: 'yep',
      });
    });

    it('handles empty values', () => {
      const input = 'EMPTY=\0';
      const result = parseShellEnv(input);
      expect(result).toEqual({ EMPTY: '' });
    });
  });

  describe('getBaseShellEnv', () => {
    beforeEach(() => {
      resetBaseShellEnvCache();
    });

    it('returns a shell environment with PATH and HOME', async () => {
      const env = await getBaseShellEnv();
      expect(env.PATH).toBeDefined();
      expect(env.PATH).toContain('/usr');
      expect(env.HOME).toBeDefined();
    });

    it('does not include server secrets', async () => {
      const env = await getBaseShellEnv();
      expect(env.PASSWORD_HASH).toBeUndefined();
      expect(env.ENCRYPTION_KEY).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
    });

    it('caches the result across calls', async () => {
      const env1 = await getBaseShellEnv();
      const env2 = await getBaseShellEnv();
      expect(env1).toBe(env2); // Same reference = cached
    });
  });

  describe('buildAgentEnv', () => {
    beforeEach(() => {
      resetBaseShellEnvCache();
    });

    it('includes base shell env vars like PATH', async () => {
      const env = await buildAgentEnv({});
      expect(env.PATH).toBeDefined();
      expect(env.HOME).toBeDefined();
    });

    it('does not include server secrets from process.env', async () => {
      const env = await buildAgentEnv({});
      expect(env.PASSWORD_HASH).toBeUndefined();
      expect(env.ENCRYPTION_KEY).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
    });

    it('sets GITHUB_TOKEN when provided', async () => {
      const env = await buildAgentEnv({ githubToken: 'ghp_test123' });
      expect(env.GITHUB_TOKEN).toBe('ghp_test123');
    });

    it('sets CLAUDE_CODE_OAUTH_TOKEN when claudeApiKey is provided', async () => {
      const env = await buildAgentEnv({ claudeApiKey: 'sk-ant-test' });
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-test');
    });

    it('does not set tokens when not provided', async () => {
      const env = await buildAgentEnv({});
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('merges user-defined env vars', async () => {
      const env = await buildAgentEnv({
        envVars: [
          { name: 'MY_API_KEY', value: 'secret123' },
          { name: 'DEBUG', value: 'true' },
        ],
      });
      expect(env.MY_API_KEY).toBe('secret123');
      expect(env.DEBUG).toBe('true');
    });

    it('user env vars override base shell env', async () => {
      const env = await buildAgentEnv({
        envVars: [{ name: 'HOME', value: '/custom/home' }],
      });
      expect(env.HOME).toBe('/custom/home');
    });

    it('user env vars can override explicit tokens', async () => {
      const env = await buildAgentEnv({
        githubToken: 'ghp_default',
        envVars: [{ name: 'GITHUB_TOKEN', value: 'ghp_override' }],
      });
      expect(env.GITHUB_TOKEN).toBe('ghp_override');
    });
  });
});
