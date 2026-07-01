import { describe, it, expect, vi } from 'vitest';
import type { Session } from '@prisma/client';
import { sseEvents, type SessionListEvent } from './events';

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

  it('still delivers claude_running on the per-session channel', () => {
    const listener = vi.fn();
    const unsubscribe = sseEvents.onClaudeRunning('session-1', listener);

    sseEvents.emitClaudeRunning('session-1', false);

    expect(listener).toHaveBeenCalledWith({
      type: 'claude_running',
      sessionId: 'session-1',
      running: false,
    });
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
