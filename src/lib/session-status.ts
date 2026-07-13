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
 * Remove a task from the background-task set (pure), returning a new map without
 * it. A no-op if the task is absent (the returned map simply won't contain it).
 * Shared by two paths: a `task_notification` settling a task, and the user
 * stopping one via the ✕ button (optimistic removal — see `dropBackgroundTask`
 * in the runner — so the indicator clears even when the SDK never emits the
 * terminal notification). Callers that need to know whether anything changed
 * check membership (`tasks.has(taskId)`) before calling.
 */
export function removeBackgroundTask(
  tasks: ReadonlyMap<string, BackgroundTask>,
  taskId: string
): ReadonlyMap<string, BackgroundTask> {
  const next = new Map(tasks);
  next.delete(taskId);
  return next;
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

/**
 * `stop_reason` values on a streaming `message_delta` that mean the turn CONTINUES
 * (the main agent is not done): it is about to run a tool, or a server tool paused
 * it. Any other terminal reason (`end_turn`, `stop_sequence`, `max_tokens`,
 * `refusal`) means the main agent finished generating for this turn.
 */
const CONTINUATION_STOP_REASONS = new Set(['tool_use', 'pause_turn']);

type BackgroundEvent =
  | { kind: 'started'; task: BackgroundTask }
  | { kind: 'settled'; taskId: string };

/**
 * Extract a background-task lifecycle event, or `null`. `task_started` adds and
 * `task_notification` settles a task. The high-frequency `task_progress` ticks
 * and `task_updated` patches are intentionally ignored.
 *
 * A background task lingering in the indicator until query teardown is possible
 * if its `task_notification` never arrives (e.g. a `killed` task, for which the
 * SDK emits no notification). This is an accepted tradeoff for a single-user
 * indicator: it never gates input, so the only impact is a stale count, and the
 * user can always clear it with the ✕ button (`stopBackgroundTask`).
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
 * - `turnActive`: whether the MAIN agent is actively generating. Driven by the
 *   message STREAM, not the SDK turn `result`: a top-level `message_start` sets it
 *   true; a top-level `message_delta` whose `stop_reason` is terminal
 *   (`end_turn`/`stop_sequence`/`max_tokens`/`refusal`) sets it false. This matters
 *   because a `run_in_background` subagent keeps the parent turn open — the SDK
 *   defers the turn `result` until the child settles — but the main agent finishes
 *   generating much earlier; keying off `result` alone would wrongly show "running"
 *   for the whole background-subagent duration. A top-level `result` still clears it
 *   as a safety net (and covers an interrupt's `error_during_execution`). Subagent
 *   (`parent_tool_use_id != null`) traffic never moves it. NOTE: the stream-driven
 *   path relies on `includePartialMessages: true` (the runner hard-enables it) so the
 *   terminal `message_delta` arrives; without partials only the `result` backstop
 *   would clear it.
 * - background tasks: `task_started` adds; a `task_notification` removes. A task
 *   with no `task_notification` (e.g. `killed`) lingers until teardown — an
 *   accepted tradeoff for an indicator-only count (see `parseBackgroundTaskEvent`).
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
    backgroundTasks = removeBackgroundTask(backgroundTasks, bg.taskId);
  }

  // --- turnActive (main agent only) ---
  if (topLevel) {
    if (message.type === 'stream_event') {
      const event = (
        message as { event?: { type?: string; delta?: { stop_reason?: string | null } } }
      ).event;
      if (event?.type === 'message_start') {
        turnActive = true;
      } else if (
        event?.type === 'message_delta' &&
        event.delta?.stop_reason &&
        !CONTINUATION_STOP_REASONS.has(event.delta.stop_reason)
      ) {
        turnActive = false;
      }
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
