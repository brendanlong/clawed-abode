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
  mergeSlashCommands,
  answerUserInput,
  hasPendingInput,
  isClaudeRunning,
  isClaudeRunningAsync,
  markAllSessionsStopped,
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
