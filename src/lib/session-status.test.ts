import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  reduceSessionMessage,
  removeBackgroundTask,
  backgroundActive,
  taskHasEndState,
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

/** Assistant message whose content includes a Monitor tool_use block. */
function monitorCall(
  toolUseId: string,
  persistent: boolean,
  parentToolUseId: string | null = null
): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Watching…' },
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Monitor',
          input: { description: 'watch CI', persistent, timeout_ms: 300000 },
        },
      ],
    },
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

  // task_updated no longer settles a task — only task_notification does. The
  // terminal-status backstop was removed (its only value was clearing a cosmetic
  // stale count on a `killed` task with no notification; for a single-user
  // indicator that lingering count is an accepted tradeoff).
  it.each(['completed', 'failed', 'killed', 'pending', 'running', 'paused'])(
    'task_updated with status %s is ignored and leaves the task running',
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

  it('a terminal task_updated leaves the task running; only the task_notification settles it', () => {
    let s = reduceSessionMessage(INITIAL_LIVE_STATUS, taskStarted('t1')).status;
    s = reduceSessionMessage(s, taskUpdated('t1', 'completed')).status;
    expect(backgroundActive(s)).toBe(true);
    const { status, changed } = reduceSessionMessage(s, taskNotification('t1'));
    expect(backgroundActive(status)).toBe(false);
    expect(changed.background).toBe(true);
  });
});

describe('taskHasEndState (daemon exclusion)', () => {
  const make = (taskType?: string, persistent = false): BackgroundTask => ({
    taskId: 't',
    ambient: false,
    taskType,
    persistent,
  });

  it('excludes backgrounded Bash daemons (local_bash)', () => {
    expect(taskHasEndState(make('local_bash'))).toBe(false);
  });

  it('excludes persistent Monitor watches', () => {
    expect(taskHasEndState(make('monitor', true))).toBe(false);
  });

  it.each(['local_agent', 'remote_agent', 'monitor', 'local_workflow'])(
    'counts %s (settles on its own)',
    (taskType) => {
      expect(taskHasEndState(make(taskType))).toBe(true);
    }
  );

  it('counts a task with an unknown/absent task_type (safe default)', () => {
    expect(taskHasEndState(make(undefined))).toBe(true);
    expect(taskHasEndState(make('some_future_kind'))).toBe(true);
  });
});

describe('backgroundActive — daemon-only sets read as idle', () => {
  it('a lone backgrounded Bash daemon does not count as background-active', () => {
    const { status } = reduceSessionMessage(
      INITIAL_LIVE_STATUS,
      taskStarted('bash1', { task_type: 'local_bash' })
    );
    // Still tracked (visible/stoppable in the indicator)...
    expect(status.backgroundTasks.has('bash1')).toBe(true);
    // ...but does not gate the background-vs-waiting badge / notification.
    expect(backgroundActive(status)).toBe(false);
  });

  it('a subagent alongside a daemon still reads background-active', () => {
    let s = reduceSessionMessage(
      INITIAL_LIVE_STATUS,
      taskStarted('bash1', { task_type: 'local_bash' })
    ).status;
    s = reduceSessionMessage(s, taskStarted('agent1', { task_type: 'local_agent' })).status;
    expect(backgroundActive(s)).toBe(true);
    // When the subagent settles, the lingering daemon no longer keeps it active.
    s = reduceSessionMessage(s, taskNotification('agent1')).status;
    expect(s.backgroundTasks.has('bash1')).toBe(true);
    expect(backgroundActive(s)).toBe(false);
  });
});

describe('persistent Monitor detection (tool_use → task_started linkage)', () => {
  it('flags a task whose tool_use_id links back to a persistent: true Monitor call', () => {
    let s = reduceSessionMessage(INITIAL_LIVE_STATUS, monitorCall('tu1', true)).status;
    expect(s.persistentMonitorToolUseIds.has('tu1')).toBe(true);
    s = reduceSessionMessage(
      s,
      taskStarted('m1', { task_type: 'monitor', tool_use_id: 'tu1' })
    ).status;
    // Tracked (visible/stoppable) but excluded from the busy axis…
    expect(s.backgroundTasks.get('m1')?.persistent).toBe(true);
    expect(backgroundActive(s)).toBe(false);
    // …and the linkage id is consumed.
    expect(s.persistentMonitorToolUseIds.has('tu1')).toBe(false);
  });

  it('a persistent: false Monitor call leaves the task counted', () => {
    let s = reduceSessionMessage(INITIAL_LIVE_STATUS, monitorCall('tu1', false)).status;
    expect(s.persistentMonitorToolUseIds.size).toBe(0);
    s = reduceSessionMessage(
      s,
      taskStarted('m1', { task_type: 'monitor', tool_use_id: 'tu1' })
    ).status;
    expect(s.backgroundTasks.get('m1')?.persistent).toBe(false);
    expect(backgroundActive(s)).toBe(true);
  });

  it('a monitor task with no matching call counts (safe default)', () => {
    const { status } = reduceSessionMessage(
      INITIAL_LIVE_STATUS,
      taskStarted('m1', { task_type: 'monitor', tool_use_id: 'unseen' })
    );
    expect(status.backgroundTasks.get('m1')?.persistent).toBe(false);
    expect(backgroundActive(status)).toBe(true);
  });

  it('links a persistent Monitor started by a subagent (non-top-level call)', () => {
    let s = reduceSessionMessage(INITIAL_LIVE_STATUS, monitorCall('tu1', true, 'parent1')).status;
    s = reduceSessionMessage(
      s,
      taskStarted('m1', { task_type: 'monitor', tool_use_id: 'tu1' })
    ).status;
    expect(s.backgroundTasks.get('m1')?.persistent).toBe(true);
    expect(backgroundActive(s)).toBe(false);
  });

  it('a persistent Monitor settling via task_notification still clears normally', () => {
    let s = reduceSessionMessage(INITIAL_LIVE_STATUS, monitorCall('tu1', true)).status;
    s = reduceSessionMessage(
      s,
      taskStarted('m1', { task_type: 'monitor', tool_use_id: 'tu1' })
    ).status;
    s = reduceSessionMessage(s, taskNotification('m1')).status;
    expect(s.backgroundTasks.has('m1')).toBe(false);
  });

  it('an assistant message without Monitor calls leaves the id set untouched', () => {
    const withId = reduceSessionMessage(INITIAL_LIVE_STATUS, monitorCall('tu1', true)).status;
    const { status } = reduceSessionMessage(withId, assistant());
    expect(status.persistentMonitorToolUseIds).toBe(withId.persistentMonitorToolUseIds);
  });
});

describe('removeBackgroundTask (optimistic ✕ removal)', () => {
  function withTasks(...taskIds: string[]): ReadonlyMap<string, BackgroundTask> {
    return new Map(taskIds.map((id) => [id, { taskId: id, ambient: false, persistent: false }]));
  }

  it('removes a present task and returns a new map without it', () => {
    const tasks = withTasks('t1', 't2');
    const next = removeBackgroundTask(tasks, 't1');
    expect(next).not.toBe(tasks);
    expect(next.has('t1')).toBe(false);
    expect(next.has('t2')).toBe(true);
  });

  it('returns a new map without the id when the task is absent (harmless no-op)', () => {
    const tasks = withTasks('t1');
    const next = removeBackgroundTask(tasks, 'ghost');
    expect(next.has('ghost')).toBe(false);
    expect(next.has('t1')).toBe(true);
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
