/**
 * Pure derivation of a session's live status from the SDK message stream.
 *
 * With one long-lived streaming query per session, "is Claude busy?" splits into
 * two independent axes:
 *
 *   - `turnActive`     — the MAIN agent is mid-turn generating. Gates the composer.
 *   - background tasks — `run_in_background` subagents / Monitor / backgrounded
 *                        Bash that outlive a turn. An indicator only; NEVER gates
 *                        input (the whole point of the refactor).
 *
 * Plus the existing ephemeral API-retry status.
 *
 * This module is a pure reducer so it is exhaustively unit-testable; the runner's
 * loop applies the returned state and emits the changed channels over SSE.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseRetryState, type RetryState } from './claude-messages';

/** A background task tracked while it runs (keyed by `task_id`). */
export interface BackgroundTask {
  taskId: string;
  toolUseId?: string;
  description?: string;
  taskType?: string;
  subagentType?: string;
  /** Ambient/housekeeping task the SDK flags to hide from the inline transcript. */
  ambient: boolean;
}

export interface LiveStatus {
  /** The main agent is mid-turn generating (gates the composer). */
  turnActive: boolean;
  /** Running background tasks by `task_id` (indicator only; never gates input). */
  backgroundTasks: ReadonlyMap<string, BackgroundTask>;
  /** Current API-retry status, or `null` when not retrying. */
  retry: RetryState | null;
}

export const INITIAL_LIVE_STATUS: LiveStatus = {
  turnActive: false,
  backgroundTasks: new Map(),
  retry: null,
};

/** Which status axes changed in a {@link reduceSessionMessage} step. */
export interface LiveStatusChange {
  turnActive: boolean;
  background: boolean;
  retry: boolean;
}

export interface ReduceResult {
  status: LiveStatus;
  changed: LiveStatusChange;
}

/** Whether any background task is currently running. */
export function backgroundActive(status: LiveStatus): boolean {
  return status.backgroundTasks.size > 0;
}

/**
 * A message is "top-level" (main agent, not a subagent) when it has no
 * `parent_tool_use_id`. `result` messages have no such field and are always
 * top-level turn boundaries.
 */
function isTopLevel(message: SDKMessage): boolean {
  const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  return parent === null || parent === undefined;
}

function retryEquals(a: RetryState | null, b: RetryState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.attempt === b.attempt &&
    a.maxRetries === b.maxRetries &&
    a.errorStatus === b.errorStatus &&
    a.error === b.error
  );
}

type BackgroundEvent =
  | { kind: 'started'; task: BackgroundTask }
  | { kind: 'settled'; taskId: string };

/**
 * Extract a background-task lifecycle event, or `null`. Only `task_started`
 * (add) and `task_notification` (terminal: completed/failed/stopped → remove)
 * drive the set; the high-frequency `task_progress`/`task_updated` ticks are
 * intentionally ignored.
 */
function parseBackgroundTaskEvent(message: SDKMessage): BackgroundEvent | null {
  if (message.type !== 'system') return null;
  const m = message as {
    subtype?: string;
    task_id?: string;
    tool_use_id?: string;
    description?: string;
    task_type?: string;
    subagent_type?: string;
    skip_transcript?: boolean;
  };
  if (typeof m.task_id !== 'string') return null;

  if (m.subtype === 'task_started') {
    return {
      kind: 'started',
      task: {
        taskId: m.task_id,
        toolUseId: m.tool_use_id,
        description: m.description,
        taskType: m.task_type,
        subagentType: m.subagent_type,
        ambient: m.skip_transcript === true,
      },
    };
  }
  if (m.subtype === 'task_notification') {
    return { kind: 'settled', taskId: m.task_id };
  }
  return null;
}

/**
 * Fold one SDK message into the live status. Pure: returns the next status and
 * which axes changed (so the caller emits only the channels that moved).
 *
 * - `turnActive`: a top-level `assistant`/`stream_event` sets it true; a top-level
 *   `result` (ANY subtype, including `error_during_execution` from an interrupt)
 *   sets it false. Subagent (`parent_tool_use_id != null`) traffic never moves it.
 * - background tasks: `task_started` adds, `task_notification` removes.
 * - retry: an `api_retry` message sets it; any other TOP-LEVEL message clears it
 *   (the main request recovered). Background traffic leaves retry untouched, so a
 *   subagent's messages can't prematurely clear a main-turn retry indicator.
 */
export function reduceSessionMessage(prev: LiveStatus, message: SDKMessage): ReduceResult {
  let { turnActive, backgroundTasks, retry } = prev;
  const topLevel = isTopLevel(message);

  // --- retry (turn-scoped) ---
  const parsedRetry = parseRetryState(message);
  if (parsedRetry) {
    retry = parsedRetry;
  } else if (topLevel) {
    retry = null;
  }

  // --- background tasks ---
  const bg = parseBackgroundTaskEvent(message);
  if (bg?.kind === 'started') {
    const next = new Map(backgroundTasks);
    next.set(bg.task.taskId, bg.task);
    backgroundTasks = next;
  } else if (bg?.kind === 'settled' && backgroundTasks.has(bg.taskId)) {
    const next = new Map(backgroundTasks);
    next.delete(bg.taskId);
    backgroundTasks = next;
  }

  // --- turnActive (main agent only) ---
  if (topLevel) {
    if (message.type === 'assistant' || message.type === 'stream_event') {
      turnActive = true;
    } else if (message.type === 'result') {
      turnActive = false;
    }
  }

  return {
    status: { turnActive, backgroundTasks, retry },
    changed: {
      turnActive: turnActive !== prev.turnActive,
      background: backgroundTasks !== prev.backgroundTasks,
      retry: !retryEquals(retry, prev.retry),
    },
  };
}
