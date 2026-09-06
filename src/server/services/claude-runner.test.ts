import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('./events', () => ({
  sseEvents: { emitClaudeRunning: vi.fn(), emitPendingMessages: vi.fn() },
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import { submitLiveToolResponse, isClaudeRunning, cleanupSession } from './claude-runner';
import { getSessionCommands, rememberSessionCommands } from './session-commands';

describe('claude-runner without a live session', () => {
  it('submitLiveToolResponse returns false immediately when no query is running', async () => {
    const result = await submitLiveToolResponse('nonexistent-session', 'toolu_1', {
      kind: 'questions',
      answers: { q: 'answer' },
    });
    expect(result).toBe(false);
  });

  it('isClaudeRunning is false for unknown sessions', () => {
    expect(isClaudeRunning('nonexistent-session')).toBe(false);
  });

  it("cleanupSession forgets the session's slash commands", () => {
    rememberSessionCommands('cleanup-me', [{ name: 'compact', description: '', argumentHint: '' }]);
    cleanupSession('cleanup-me');
    expect(getSessionCommands('cleanup-me')).toEqual([]);
  });
});
