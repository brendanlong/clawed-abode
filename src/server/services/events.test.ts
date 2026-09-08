import { toSessionView } from '@/lib/session-view';
import { describe, it, expect, vi } from 'vitest';
import type { Session } from '@/generated/prisma/client';
import { sseEvents, type SessionListEvent, type SessionStreamEvent } from './events';

const fakeSession = { id: 'session-1', name: 'Test', pullRequest: null } as Session;

function listen(sessionId: string) {
  const session = vi.fn<(event: SessionStreamEvent) => void>();
  const list = vi.fn<(event: SessionListEvent) => void>();
  const unsubscribeSession = sseEvents.onSessionEvents(sessionId, session);
  const unsubscribeList = sseEvents.onSessionListChanged(list);
  return {
    session,
    list,
    unsubscribe: () => {
      unsubscribeSession();
      unsubscribeList();
    },
  };
}

describe('sseEvents', () => {
  it('delivers the full session view per-session and only id/name to the list channel', () => {
    const l = listen('session-1');

    sseEvents.emitSessionUpdate('session-1', fakeSession);

    // The row goes out as the API view: the pullRequest JSON column is decoded.
    expect(l.session).toHaveBeenCalledWith({
      kind: 'session',
      session: toSessionView(fakeSession),
    });
    expect(l.list).toHaveBeenCalledWith({ kind: 'session', sessionId: 'session-1', name: 'Test' });
    l.unsubscribe();
  });

  it('delivers running changes to both channels', () => {
    const l = listen('session-1');

    sseEvents.emitClaudeRunning('session-1', true);

    expect(l.session).toHaveBeenCalledWith({ kind: 'running', running: true });
    expect(l.list).toHaveBeenCalledWith({ kind: 'running', sessionId: 'session-1', running: true });
    l.unsubscribe();
  });

  it('delivers finished to the list channel only', () => {
    const l = listen('session-1');

    sseEvents.emitClaudeFinished('session-1');

    expect(l.session).not.toHaveBeenCalled();
    expect(l.list).toHaveBeenCalledWith({ kind: 'finished', sessionId: 'session-1' });
    l.unsubscribe();
  });

  it('delivers per-session-only kinds on the session channel alone', () => {
    const l = listen('session-1');

    const message = {
      id: 'm1',
      sessionId: 'session-1',
      sequence: 0,
      type: 'user',
      content: {},
      createdAt: new Date(),
    };
    sseEvents.emitNewMessage('session-1', message);
    sseEvents.emitCommands('session-1', []);
    sseEvents.emitClaudeRetry('session-1', null);
    sseEvents.emitPendingMessages('session-1', ['m1']);
    sseEvents.emitMessageRemoved('session-1', 'm1');

    expect(l.session.mock.calls.map(([e]) => e)).toEqual([
      { kind: 'message', message },
      { kind: 'commands', commands: [] },
      { kind: 'retry', retry: null },
      { kind: 'pending', messageIds: ['m1'] },
      { kind: 'message_removed', messageId: 'm1' },
    ]);
    expect(l.list).not.toHaveBeenCalled();
    l.unsubscribe();
  });

  it('does not deliver another session’s events', () => {
    const l = listen('session-2');

    sseEvents.emitClaudeRunning('session-1', true);

    expect(l.session).not.toHaveBeenCalled();
    l.unsubscribe();
  });

  it('fans the full task list per-session and a lightweight active/idle signal to the list', () => {
    const l = listen('session-1');

    const tasks = [
      { taskId: 't1', ambient: false, persistent: false },
      { taskId: 't2', ambient: false, persistent: false },
    ];
    sseEvents.emitBackgroundTasks('session-1', tasks);
    expect(l.session).toHaveBeenCalledWith({ kind: 'background', tasks });
    expect(l.list).toHaveBeenCalledWith({
      kind: 'background',
      sessionId: 'session-1',
      active: true,
    });

    // An empty set signals idle (drives the badge back to "waiting" even when no
    // running/finished edge fired — e.g. a ✕-stop or a settle with no continuation).
    l.list.mockClear();
    sseEvents.emitBackgroundTasks('session-1', []);
    expect(l.list).toHaveBeenCalledWith({
      kind: 'background',
      sessionId: 'session-1',
      active: false,
    });

    // A set holding only no-end-state tasks (a Bash daemon, a persistent Monitor)
    // also signals idle — they don't count toward the busy axis (taskHasEndState).
    l.list.mockClear();
    sseEvents.emitBackgroundTasks('session-1', [
      { taskId: 'd1', ambient: false, persistent: false, taskType: 'local_bash' },
      { taskId: 'm1', ambient: false, persistent: true, taskType: 'monitor' },
    ]);
    expect(l.list).toHaveBeenCalledWith({
      kind: 'background',
      sessionId: 'session-1',
      active: false,
    });
    l.unsubscribe();
  });

  it('stops delivering after unsubscribe', () => {
    const l = listen('session-1');
    l.unsubscribe();

    sseEvents.emitClaudeRunning('session-1', true);

    expect(l.session).not.toHaveBeenCalled();
    expect(l.list).not.toHaveBeenCalled();
  });
});
