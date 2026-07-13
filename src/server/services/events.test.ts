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

  it('fans a lightweight claude_background active/idle signal to the global list channel', () => {
    const listener = vi.fn<(event: SessionListEvent) => void>();
    const unsubscribe = sseEvents.onSessionListChanged(listener);

    sseEvents.emitBackgroundTasks('session-1', [
      { taskId: 't1', ambient: false },
      { taskId: 't2', ambient: false },
    ]);
    expect(listener).toHaveBeenCalledWith({
      type: 'claude_background',
      sessionId: 'session-1',
      active: true,
    });

    // An empty set signals idle (drives the badge back to "waiting" even when no
    // running/finished edge fired — e.g. a ✕-stop or a settle with no continuation).
    listener.mockClear();
    sseEvents.emitBackgroundTasks('session-1', []);
    expect(listener).toHaveBeenCalledWith({
      type: 'claude_background',
      sessionId: 'session-1',
      active: false,
    });
    unsubscribe();
  });

  it('still delivers the full background-task list on the multiplexed per-session stream', () => {
    const listener = vi.fn<(event: SessionStreamEvent) => void>();
    const unsubscribe = sseEvents.onSessionEvents('session-1', listener);

    const tasks = [{ taskId: 't1', ambient: false }];
    sseEvents.emitBackgroundTasks('session-1', tasks);

    expect(listener).toHaveBeenCalledWith({ kind: 'background', tasks });
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
