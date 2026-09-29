import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  reduceSessionMessage,
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

interface LevelTask {
  task_id: string;
  task_type?: string;
  ambient?: boolean;
}

function backgroundTasksChanged(...tasks: (string | LevelTask)[]): SDKMessage {
  return {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: tasks
      .map((t) => (typeof t === 'string' ? { task_id: t } : t))
      .map((t) => ({ task_type: 'local_agent', description: `task ${t.task_id}`, ...t })),
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
  it('background_tasks_changed replaces the set', () => {
    let s = reduceSessionMessage(INITIAL_LIVE_STATUS, backgroundTasksChanged('t1', 't2')).status;
    expect([...s.backgroundTasks.keys()]).toEqual(['t1', 't2']);
    expect(s.backgroundTasks.get('t1')).toEqual({
      taskId: 't1',
      taskType: 'local_agent',
      description: 'task t1',
      subagentType: undefined,
      ambient: false,
    });

    const { status, changed } = reduceSessionMessage(s, backgroundTasksChanged('t2'));
    s = status;
    expect([...s.backgroundTasks.keys()]).toEqual(['t2']);
    expect(changed.background).toBe(true);
  });

  it('an empty payload clears the set even without task_notification edges', () => {
    const s = reduceSessionMessage(INITIAL_LIVE_STATUS, backgroundTasksChanged('t1')).status;
    const { status } = reduceSessionMessage(s, backgroundTasksChanged());
    expect(status.backgroundTasks.size).toBe(0);
    expect(backgroundActive(status)).toBe(false);
  });

  it('task_started / task_notification edges do not change membership', () => {
    let r = reduceSessionMessage(INITIAL_LIVE_STATUS, taskStarted('t1'));
    expect(r.status.backgroundTasks.size).toBe(0);
    expect(r.changed.background).toBe(false);

    const withTask = reduceSessionMessage(INITIAL_LIVE_STATUS, backgroundTasksChanged('t1')).status;
    r = reduceSessionMessage(withTask, taskNotification('t1'));
    expect(r.status.backgroundTasks.has('t1')).toBe(true);
    expect(r.changed.background).toBe(false);
  });

  it('an unparseable payload leaves the set untouched', () => {
    const s = reduceSessionMessage(INITIAL_LIVE_STATUS, backgroundTasksChanged('t1')).status;
    const bad = { type: 'system', subtype: 'background_tasks_changed' } as unknown as SDKMessage;
    const { status, changed } = reduceSessionMessage(s, bad);
    expect(status.backgroundTasks).toBe(s.backgroundTasks);
    expect(changed.background).toBe(false);
  });

  it('carries the ambient flag', () => {
    const { status } = reduceSessionMessage(
      INITIAL_LIVE_STATUS,
      backgroundTasksChanged({ task_id: 'a1', task_type: 'dream', ambient: true })
    );
    expect(status.backgroundTasks.get('a1')?.ambient).toBe(true);
  });

  it('background activity does not affect turnActive', () => {
    const { status } = reduceSessionMessage(INITIAL_LIVE_STATUS, backgroundTasksChanged('t1'));
    expect(status.turnActive).toBe(false);
  });
});

describe('reduceSessionMessage — subagentType from task_started', () => {
  it('applies to a task the level lists later', () => {
    let s = reduceSessionMessage(
      INITIAL_LIVE_STATUS,
      taskStarted('t1', { subagent_type: 'Explore' })
    ).status;
    s = reduceSessionMessage(s, backgroundTasksChanged('t1')).status;
    expect(s.backgroundTasks.get('t1')?.subagentType).toBe('Explore');
  });

  it('patches a task the level listed first', () => {
    let s = reduceSessionMessage(INITIAL_LIVE_STATUS, backgroundTasksChanged('t1')).status;
    const { status, changed } = reduceSessionMessage(
      s,
      taskStarted('t1', { subagent_type: 'Explore' })
    );
    s = status;
    expect(s.backgroundTasks.get('t1')?.subagentType).toBe('Explore');
    expect(changed.background).toBe(true);
  });

  it('survives later level payloads', () => {
    let s = reduceSessionMessage(
      INITIAL_LIVE_STATUS,
      taskStarted('t1', { subagent_type: 'Explore' })
    ).status;
    s = reduceSessionMessage(s, backgroundTasksChanged('t1')).status;
    s = reduceSessionMessage(s, backgroundTasksChanged('t1', 't2')).status;
    expect(s.backgroundTasks.get('t1')?.subagentType).toBe('Explore');
  });

  it('is forgotten at the task_notification', () => {
    let s = reduceSessionMessage(
      INITIAL_LIVE_STATUS,
      taskStarted('t1', { subagent_type: 'Explore' })
    ).status;
    s = reduceSessionMessage(s, taskNotification('t1')).status;
    expect(s.subagentTypes.size).toBe(0);
  });

  it('is forgotten when a level payload no longer lists the task (foreground subagent)', () => {
    let s = reduceSessionMessage(
      INITIAL_LIVE_STATUS,
      taskStarted('fg', { subagent_type: 'Explore' })
    ).status;
    s = reduceSessionMessage(s, backgroundTasksChanged('t2')).status;
    expect(s.subagentTypes.has('fg')).toBe(false);
  });
});

describe('taskHasEndState', () => {
  const make = (taskType: string, ambient = false): BackgroundTask => ({
    taskId: 't',
    taskType,
    description: 'd',
    ambient,
  });

  it('excludes local_bash (backgrounded Bash and every Monitor watch)', () => {
    expect(taskHasEndState(make('local_bash'))).toBe(false);
  });

  it('excludes ambient tasks', () => {
    expect(taskHasEndState(make('local_agent', true))).toBe(false);
  });

  it.each(['local_agent', 'remote_agent', 'local_workflow', 'some_future_kind'])(
    'counts non-ambient %s',
    (taskType) => {
      expect(taskHasEndState(make(taskType))).toBe(true);
    }
  );
});

describe('backgroundActive — daemon-only sets read as idle', () => {
  it('a set of only local_bash / ambient tasks is not background-active', () => {
    const { status } = reduceSessionMessage(
      INITIAL_LIVE_STATUS,
      backgroundTasksChanged(
        { task_id: 'bash1', task_type: 'local_bash' },
        { task_id: 'amb1', ambient: true }
      )
    );
    // Still tracked (visible/stoppable in the indicator)...
    expect(status.backgroundTasks.size).toBe(2);
    // ...but does not gate the background-vs-waiting badge / notification.
    expect(backgroundActive(status)).toBe(false);
  });

  it('a subagent alongside a daemon reads background-active', () => {
    const { status } = reduceSessionMessage(
      INITIAL_LIVE_STATUS,
      backgroundTasksChanged({ task_id: 'bash1', task_type: 'local_bash' }, 'agent1')
    );
    expect(backgroundActive(status)).toBe(true);
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
