import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  reduceSessionMessage,
  backgroundActive,
  INITIAL_LIVE_STATUS,
  type LiveStatus,
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

function streamEvent(parentToolUseId: string | null = null): SDKMessage {
  return {
    type: 'stream_event',
    parent_tool_use_id: parentToolUseId,
    event: { type: 'content_block_delta' },
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
  it('a top-level assistant message sets turnActive true', () => {
    const { status, changed } = reduceSessionMessage(INITIAL_LIVE_STATUS, assistant());
    expect(status.turnActive).toBe(true);
    expect(changed.turnActive).toBe(true);
  });

  it('a top-level stream_event sets turnActive true', () => {
    const { status } = reduceSessionMessage(INITIAL_LIVE_STATUS, streamEvent());
    expect(status.turnActive).toBe(true);
  });

  it('a subagent assistant (parent_tool_use_id set) does NOT set turnActive', () => {
    const { status, changed } = reduceSessionMessage(INITIAL_LIVE_STATUS, assistant('tool_abc'));
    expect(status.turnActive).toBe(false);
    expect(changed.turnActive).toBe(false);
  });

  it('a subagent stream_event does NOT set turnActive', () => {
    const { status } = reduceSessionMessage(INITIAL_LIVE_STATUS, streamEvent('tool_abc'));
    expect(status.turnActive).toBe(false);
  });

  it('a result sets turnActive false', () => {
    const active: LiveStatus = { ...INITIAL_LIVE_STATUS, turnActive: true };
    const { status, changed } = reduceSessionMessage(active, result());
    expect(status.turnActive).toBe(false);
    expect(changed.turnActive).toBe(true);
  });

  it('an interrupt result (error_during_execution) sets turnActive false', () => {
    const active: LiveStatus = { ...INITIAL_LIVE_STATUS, turnActive: true };
    const { status } = reduceSessionMessage(active, result('error_during_execution'));
    expect(status.turnActive).toBe(false);
  });

  it('a second init mid-stream does not change turnActive', () => {
    const active: LiveStatus = { ...INITIAL_LIVE_STATUS, turnActive: true };
    const { status, changed } = reduceSessionMessage(active, init());
    expect(status.turnActive).toBe(true);
    expect(changed.turnActive).toBe(false);
  });

  it('no change when an already-active turn sees another assistant', () => {
    const active: LiveStatus = { ...INITIAL_LIVE_STATUS, turnActive: true };
    const { changed } = reduceSessionMessage(active, assistant());
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

  it('no retry change when none set and a normal message arrives', () => {
    const { changed } = reduceSessionMessage(INITIAL_LIVE_STATUS, assistant());
    expect(changed.retry).toBe(false);
  });
});
