import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  reduceSessionMessage,
  removeBackgroundTask,
  backgroundActive,
  INITIAL_LIVE_STATUS,
  type LiveStatus,
  type BackgroundTask,
} from './session-status';

// --- minimal message builders (cast through unknown; tests only set the fields
//     the reducer reads) ----------------------------------------------------
function assistant(parentToolUseId: string | null = null): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    message: { role: 'assistant', content: [] },
    session_id: 's',
    uuid: 'u',
  } as unknown as SDKMessage;
}

function messageStart(parentToolUseId: string | null = null): SDKMessage {
  return {
    type: 'stream_event',
    parent_tool_use_id: parentToolUseId,
    event: { type: 'message_start' },
    session_id: 's',
    uuid: 'u',
  } as unknown as SDKMessage;
}

function messageDelta(
  stopReason: string | null,
  parentToolUseId: string | null = null
): SDKMessage {
  return {
    type: 'stream_event',
    parent_tool_use_id: parentToolUseId,
    event: { type: 'message_delta', delta: { stop_reason: stopReason } },
    session_id: 's',
    uuid: 'u',
  } as unknown as SDKMessage;
}

function result(subtype = 'success'): SDKMessage {
  return { type: 'result', subtype, session_id: 's', uuid: 'u' } as unknown as SDKMessage;
}

function init(): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 's',
    model: 'claude',
    cwd: '/tmp',
  } as unknown as SDKMessage;
}

function taskStarted(taskId: string, opts: Partial<Record<string, unknown>> = {}): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    description: 'do a thing',
    session_id: 's',
    uuid: 'u',
    ...opts,
  } as unknown as SDKMessage;
}

function taskNotification(taskId: string, status = 'completed'): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status,
    output_file: '/tmp/out',
    summary: 'done',
    session_id: 's',
    uuid: 'u',
  } as unknown as SDKMessage;
}

function taskUpdated(taskId: string, status: string | undefined): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: taskId,
    patch: { status },
    session_id: 's',
    uuid: 'u',
  } as unknown as SDKMessage;
}

function apiRetry(attempt: number): SDKMessage {
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt,
    max_retries: 10,
    error: 'overloaded',
  } as unknown as SDKMessage;
}

describe('reduceSessionMessage — turnActive', () => {
  it('a top-level message_start sets turnActive true', () => {
    const { status, changed } = reduceSessionMessage(INITIAL_LIVE_STATUS, messageStart());
    expect(status.turnActive).toBe(true);
    expect(changed.turnActive).toBe(true);
  });

  it('a top-level message_delta with a terminal stop_reason ends the turn', () => {
    for (const reason of ['end_turn', 'stop_sequence', 'max_tokens', 'refusal']) {
      const active: LiveStatus = { ...INITIAL_LIVE_STATUS, turnActive: true };
      const { status } = reduceSessionMessage(active, messageDelta(reason));
      expect(status.turnActive, `stop_reason=${reason}`).toBe(false);
    }
  });

  it('a message_delta with a continuation stop_reason does NOT end the turn', () => {
    for (const reason of ['tool_use', 'pause_turn']) {
      const active: LiveStatus = { ...INITIAL_LIVE_STATUS, turnActive: true };
      const { status, changed } = reduceSessionMessage(active, messageDelta(reason));
      expect(status.turnActive, `stop_reason=${reason}`).toBe(true);
      expect(changed.turnActive, `stop_reason=${reason}`).toBe(false);
    }
  });

  it('a subagent message_start does NOT set turnActive', () => {
    const { status } = reduceSessionMessage(INITIAL_LIVE_STATUS, messageStart('tool_abc'));
    expect(status.turnActive).toBe(false);
  });

  it('a subagent message_delta(end_turn) does NOT clear the main turnActive', () => {
    const active: LiveStatus = { ...INITIAL_LIVE_STATUS, turnActive: true };
    const { status, changed } = reduceSessionMessage(active, messageDelta('end_turn', 'tool_abc'));
    expect(status.turnActive).toBe(true);
    expect(changed.turnActive).toBe(false);
  });

  it('a top-level result clears turnActive (safety net / interrupt)', () => {
    const active: LiveStatus = { ...INITIAL_LIVE_STATUS, turnActive: true };
    expect(reduceSessionMessage(active, result()).status.turnActive).toBe(false);
    expect(reduceSessionMessage(active, result('error_during_execution')).status.turnActive).toBe(
      false
    );
  });

  it('the main agent ending its turn frees turnActive while a background subagent still streams', () => {
    // Regression for the run_in_background subagent case: the SDK keeps the parent
    // turn open (defers the result) until the child settles, but the main agent's
    // end_turn must free the composer immediately, and subagent traffic must not
    // re-activate it.
    let s = reduceSessionMessage(INITIAL_LIVE_STATUS, messageStart()).status; // main generating
    s = reduceSessionMessage(s, messageDelta('tool_use')).status; // launches bg agent
    s = reduceSessionMessage(s, messageStart()).status; // main says "STARTED"
    s = reduceSessionMessage(s, messageDelta('end_turn')).status; // main DONE
    expect(s.turnActive).toBe(false);

    // The background subagent keeps streaming — must NOT re-activate the main turn.
    s = reduceSessionMessage(s, messageStart('tool_xyz')).status;
    s = reduceSessionMessage(s, messageDelta('end_turn', 'tool_xyz')).status;
    expect(s.turnActive).toBe(false);

    // Later, the main agent autonomously continues → active again.
    s = reduceSessionMessage(s, messageStart()).status;
    expect(s.turnActive).toBe(true);
  });

  it('a second init mid-stream does not change turnActive', () => {
    const active: LiveStatus = { ...INITIAL_LIVE_STATUS, turnActive: true };
    const { status, changed } = reduceSessionMessage(active, init());
    expect(status.turnActive).toBe(true);
    expect(changed.turnActive).toBe(false);
  });
});

describe('reduceSessionMessage — background tasks', () => {
  it('task_started adds a background task', () => {
    const { status, changed } = reduceSessionMessage(INITIAL_LIVE_STATUS, taskStarted('t1'));
    expect(backgroundActive(status)).toBe(true);
    expect(changed.background).toBe(true);
    expect(status.backgroundTasks.get('t1')?.description).toBe('do a thing');
    expect(status.backgroundTasks.get('t1')?.ambient).toBe(false);
  });

  it('marks ambient tasks (skip_transcript) as ambient', () => {
    const { status } = reduceSessionMessage(
      INITIAL_LIVE_STATUS,
      taskStarted('t1', { skip_transcript: true })
    );
    expect(status.backgroundTasks.get('t1')?.ambient).toBe(true);
  });

  it('task_notification removes the matching task', () => {
    const started = reduceSessionMessage(INITIAL_LIVE_STATUS, taskStarted('t1')).status;
    const { status, changed } = reduceSessionMessage(started, taskNotification('t1'));
    expect(backgroundActive(status)).toBe(false);
    expect(changed.background).toBe(true);
  });

  it('task_notification for an unknown id is a no-op', () => {
    const { status, changed } = reduceSessionMessage(
      INITIAL_LIVE_STATUS,
      taskNotification('ghost')
    );
    expect(backgroundActive(status)).toBe(false);
    expect(changed.background).toBe(false);
  });

  it('tracks multiple concurrent background tasks', () => {
    let s = reduceSessionMessage(INITIAL_LIVE_STATUS, taskStarted('t1')).status;
    s = reduceSessionMessage(s, taskStarted('t2')).status;
    expect(s.backgroundTasks.size).toBe(2);
    s = reduceSessionMessage(s, taskNotification('t1')).status;
    expect(s.backgroundTasks.size).toBe(1);
    expect(s.backgroundTasks.has('t2')).toBe(true);
  });

  it('background activity does not affect turnActive', () => {
    const { status } = reduceSessionMessage(INITIAL_LIVE_STATUS, taskStarted('t1'));
    expect(status.turnActive).toBe(false);
  });

  it.each(['completed', 'failed', 'killed'])(
    'task_updated with terminal status %s settles the task',
    (status) => {
      const started = reduceSessionMessage(INITIAL_LIVE_STATUS, taskStarted('t1')).status;
      const { status: next, changed } = reduceSessionMessage(started, taskUpdated('t1', status));
      expect(backgroundActive(next)).toBe(false);
      expect(changed.background).toBe(true);
    }
  );

  it.each(['pending', 'running', 'paused'])(
    'task_updated with non-terminal status %s leaves the task running',
    (status) => {
      const started = reduceSessionMessage(INITIAL_LIVE_STATUS, taskStarted('t1')).status;
      const { status: next, changed } = reduceSessionMessage(started, taskUpdated('t1', status));
      expect(next.backgroundTasks.has('t1')).toBe(true);
      expect(changed.background).toBe(false);
    }
  );

  it('task_updated with no status patch is a no-op', () => {
    const started = reduceSessionMessage(INITIAL_LIVE_STATUS, taskStarted('t1')).status;
    const { changed } = reduceSessionMessage(started, taskUpdated('t1', undefined));
    expect(changed.background).toBe(false);
  });

  it('a terminal task_updated then a late task_notification is a no-op (already settled)', () => {
    let s = reduceSessionMessage(INITIAL_LIVE_STATUS, taskStarted('t1')).status;
    s = reduceSessionMessage(s, taskUpdated('t1', 'completed')).status;
    expect(backgroundActive(s)).toBe(false);
    const { changed } = reduceSessionMessage(s, taskNotification('t1'));
    expect(changed.background).toBe(false);
  });
});

describe('removeBackgroundTask (optimistic ✕ removal)', () => {
  function withTasks(...taskIds: string[]): ReadonlyMap<string, BackgroundTask> {
    return new Map(taskIds.map((id) => [id, { taskId: id, ambient: false }]));
  }

  it('removes a present task and returns a new map without it', () => {
    const tasks = withTasks('t1', 't2');
    const next = removeBackgroundTask(tasks, 't1');
    expect(next).not.toBe(tasks);
    expect(next.has('t1')).toBe(false);
    expect(next.has('t2')).toBe(true);
  });

  it('returns the SAME map reference when the task is absent (no change)', () => {
    const tasks = withTasks('t1');
    expect(removeBackgroundTask(tasks, 'ghost')).toBe(tasks);
  });

  it('removing the last task yields an empty set', () => {
    const next = removeBackgroundTask(withTasks('t1'), 't1');
    expect(next.size).toBe(0);
  });
});

describe('reduceSessionMessage — retry (turn-scoped clear)', () => {
  it('api_retry sets retry state', () => {
    const { status, changed } = reduceSessionMessage(INITIAL_LIVE_STATUS, apiRetry(2));
    expect(status.retry).toEqual({
      attempt: 2,
      maxRetries: 10,
      errorStatus: undefined,
      error: 'overloaded',
    });
    expect(changed.retry).toBe(true);
  });

  it('a subsequent top-level message clears retry', () => {
    const retrying = reduceSessionMessage(INITIAL_LIVE_STATUS, apiRetry(2)).status;
    const { status, changed } = reduceSessionMessage(retrying, assistant());
    expect(status.retry).toBeNull();
    expect(changed.retry).toBe(true);
  });

  it('a subagent (background) message does NOT clear a main-turn retry', () => {
    const retrying = reduceSessionMessage(INITIAL_LIVE_STATUS, apiRetry(2)).status;
    const { status, changed } = reduceSessionMessage(retrying, assistant('tool_abc'));
    expect(status.retry).not.toBeNull();
    expect(changed.retry).toBe(false);
  });

  it('a top-level message_start clears retry (the request recovered and is streaming)', () => {
    const retrying = reduceSessionMessage(INITIAL_LIVE_STATUS, apiRetry(2)).status;
    const { status, changed } = reduceSessionMessage(retrying, messageStart());
    expect(status.retry).toBeNull();
    expect(changed.retry).toBe(true);
  });

  it('no retry change when none set and a normal message arrives', () => {
    const { changed } = reduceSessionMessage(INITIAL_LIVE_STATUS, assistant());
    expect(changed.retry).toBe(false);
  });
});
