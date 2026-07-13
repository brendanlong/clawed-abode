import { describe, it, expect, vi } from 'vitest';
import type { Session } from '@/generated/prisma/client';
import { sseEvents, type SessionListEvent, type SessionStreamEvent } from './events';

const fakeSession = { id: 'session-1', name: 'Test' } as Session;

describe('sseEvents session-list fan-out', () => {
  it('delivers session updates to the global list channel', () => {
    const listener = vi.fn<(event: SessionListEvent) => void>();
    const unsubscribe = sseEvents.onSessionListChanged(listener);

    sseEvents.emitSessionUpdate('session-1', fakeSession);

    expect(listener).toHaveBeenCalledWith({
      type: 'session_update',
      sessionId: 'session-1',
      session: fakeSession,
    });
    unsubscribe();
  });

  it('delivers claude_running changes to the global list channel', () => {
    const listener = vi.fn<(event: SessionListEvent) => void>();
    const unsubscribe = sseEvents.onSessionListChanged(listener);

    sseEvents.emitClaudeRunning('session-1', true);

    expect(listener).toHaveBeenCalledWith({
      type: 'claude_running',
      sessionId: 'session-1',
      running: true,
    });
    unsubscribe();
  });

  it('still delivers claude_running on the multiplexed per-session stream', () => {
    const listener = vi.fn<(event: SessionStreamEvent) => void>();
    const unsubscribe = sseEvents.onSessionEvents('session-1', listener);

    sseEvents.emitClaudeRunning('session-1', false);

    expect(listener).toHaveBeenCalledWith({ kind: 'running', running: false });
    unsubscribe();
  });

  it('stops delivering after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = sseEvents.onSessionListChanged(listener);
    unsubscribe();

    sseEvents.emitClaudeRunning('session-1', true);

    expect(listener).not.toHaveBeenCalled();
  });
});
