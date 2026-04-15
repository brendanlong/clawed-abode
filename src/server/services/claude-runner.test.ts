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
  buildAgentEnv,
  getBaseEnv,
  resetBaseEnvCache,
  mergeSlashCommands,
  getSessionCommands,
  answerUserInput,
  hasPendingInput,
  isClaudeRunning,
  isClaudeRunningAsync,
  markAllSessionsStopped,
  cleanupSession,
  _setPersistedCommands,
  _clearPersistedCommands,
} from './claude-runner';

describe('claude-runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getBaseEnv', () => {
    beforeEach(() => {
      resetBaseEnvCache();
    });

    it('should capture environment from a login shell', async () => {
      const baseEnv = await getBaseEnv();
      // A login shell should always have PATH and HOME
      expect(baseEnv.PATH).toBeDefined();
      expect(baseEnv.HOME).toBeDefined();
    });

    it('should not include server-specific env vars', async () => {
      // These are set in the server process but should not appear
      // in a fresh login shell's environment
      const baseEnv = await getBaseEnv();
      expect(baseEnv.PASSWORD_HASH).toBeUndefined();
      expect(baseEnv.ENCRYPTION_KEY).toBeUndefined();
      expect(baseEnv.DATABASE_URL).toBeUndefined();
      expect(baseEnv.NEXT_RUNTIME).toBeUndefined();
    });

    it('should cache results across calls', async () => {
      const first = await getBaseEnv();
      const second = await getBaseEnv();
      expect(first).toBe(second); // Same reference = cached
    });

    it('should coalesce concurrent calls', async () => {
      // Fire two calls before the first resolves
      const [first, second] = await Promise.all([getBaseEnv(), getBaseEnv()]);
      // Both should return the same cached object
      expect(first).toBe(second);
    });
  });

  describe('buildAgentEnv', () => {
    beforeEach(() => {
      resetBaseEnvCache();
    });

    it('should include base env vars from login shell', async () => {
      const env = await buildAgentEnv([]);
      // Should have standard shell vars
      expect(env.PATH).toBeDefined();
      expect(env.HOME).toBeDefined();
    });

    it('should not include server-only env vars', async () => {
      const env = await buildAgentEnv([]);
      expect(env.PASSWORD_HASH).toBeUndefined();
      expect(env.ENCRYPTION_KEY).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
    });

    it('should overlay user-configured env vars', async () => {
      const env = await buildAgentEnv([
        { name: 'MY_API_KEY', value: 'key-123' },
        { name: 'MY_SECRET', value: 'decrypted-secret' },
      ]);
      expect(env.MY_API_KEY).toBe('key-123');
      expect(env.MY_SECRET).toBe('decrypted-secret');
    });

    it('should allow user env vars to override base env vars', async () => {
      const env = await buildAgentEnv([{ name: 'HOME', value: '/custom/home' }]);
      expect(env.HOME).toBe('/custom/home');
    });

    it('should set CLAUDE_CODE_OAUTH_TOKEN when claudeApiKey is provided', async () => {
      const env = await buildAgentEnv([], 'custom-api-key');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('custom-api-key');
    });

    it('should not set CLAUDE_CODE_OAUTH_TOKEN when claudeApiKey is null', async () => {
      const env = await buildAgentEnv([], null);
      // Should not have CLAUDE_CODE_OAUTH_TOKEN from the server process
      // (it wouldn't be in a clean login shell either)
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('should allow per-repo env var to override claudeApiKey', async () => {
      const env = await buildAgentEnv(
        [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'per-repo-key' }],
        'global-api-key'
      );
      // Per-repo env var should take precedence over global API key
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('per-repo-key');
    });
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

  describe('mergeSlashCommands', () => {
    it('should return existing commands when no new names provided', () => {
      const existing = [{ name: 'commit', description: 'Commit changes', argumentHint: '' }];
      const result = mergeSlashCommands(existing, []);
      expect(result).toEqual(existing);
    });

    it('should add new commands not in existing list', () => {
      const existing = [{ name: 'commit', description: 'Commit changes', argumentHint: '' }];
      const result = mergeSlashCommands(existing, ['compact', 'cost']);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        name: 'commit',
        description: 'Commit changes',
        argumentHint: '',
      });
      expect(result[1]).toEqual({ name: 'compact', description: '', argumentHint: '' });
      expect(result[2]).toEqual({ name: 'cost', description: '', argumentHint: '' });
    });

    it('should not duplicate commands already in existing list', () => {
      const existing = [
        { name: 'commit', description: 'Commit changes', argumentHint: '' },
        { name: 'review', description: 'Review code', argumentHint: '<pr>' },
      ];
      const result = mergeSlashCommands(existing, ['commit', 'review', 'compact']);
      expect(result).toHaveLength(3);
      // Original rich metadata preserved
      expect(result[0]).toEqual({
        name: 'commit',
        description: 'Commit changes',
        argumentHint: '',
      });
      expect(result[1]).toEqual({
        name: 'review',
        description: 'Review code',
        argumentHint: '<pr>',
      });
      // New command added with empty metadata
      expect(result[2]).toEqual({ name: 'compact', description: '', argumentHint: '' });
    });

    it('should handle empty existing commands', () => {
      const result = mergeSlashCommands([], ['compact', 'cost']);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: 'compact', description: '', argumentHint: '' });
      expect(result[1]).toEqual({ name: 'cost', description: '', argumentHint: '' });
    });

    it('should handle both empty', () => {
      const result = mergeSlashCommands([], []);
      expect(result).toEqual([]);
    });

    it('should deduplicate names within slashCommandNames', () => {
      const result = mergeSlashCommands([], ['compact', 'compact', 'cost', 'cost']);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: 'compact', description: '', argumentHint: '' });
      expect(result[1]).toEqual({ name: 'cost', description: '', argumentHint: '' });
    });
  });

  describe('getSessionCommands', () => {
    it('should return empty array for nonexistent sessions', () => {
      expect(getSessionCommands('nonexistent-session')).toEqual([]);
    });

    it('should return persisted commands after they are set', () => {
      const sessionId = 'test-persisted-commands';
      const commands = [
        { name: 'commit', description: 'Commit changes', argumentHint: '' },
        { name: 'review', description: 'Review code', argumentHint: '<pr>' },
      ];
      _setPersistedCommands(sessionId, commands);
      expect(getSessionCommands(sessionId)).toEqual(commands);
      _clearPersistedCommands(sessionId);
    });

    it('should still return persisted commands after session state is cleaned up', () => {
      const sessionId = 'test-persist-after-cleanup';
      const commands = [{ name: 'compact', description: '', argumentHint: '' }];
      _setPersistedCommands(sessionId, commands);
      // Simulates what happens after a query completes (sessions.delete is called)
      // getSessionCommands should still return persisted commands
      expect(getSessionCommands(sessionId)).toEqual(commands);
      _clearPersistedCommands(sessionId);
    });

    it('should return empty after cleanupSession removes persisted commands', () => {
      const sessionId = 'test-cleanup-session';
      const commands = [{ name: 'compact', description: '', argumentHint: '' }];
      _setPersistedCommands(sessionId, commands);
      expect(getSessionCommands(sessionId)).toEqual(commands);

      cleanupSession(sessionId);
      expect(getSessionCommands(sessionId)).toEqual([]);
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
});
