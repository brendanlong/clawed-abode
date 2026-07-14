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
  /**
   * A session-length `persistent: true` Monitor watch — no `timeout_ms` deadline,
   * so it has no knowable end state (see {@link taskHasEndState}). Detected by
   * linking the task's `tool_use_id` back to its Monitor `tool_use` block's input,
   * which streams through the reducer before the `task_started`.
   */
  persistent: boolean;
}

export interface LiveStatus {
  /** The main agent is mid-turn generating (gates the composer). */
  turnActive: boolean;
  /** Running background tasks by `task_id` (indicator only; never gates input). */
  backgroundTasks: ReadonlyMap<string, BackgroundTask>;
  /** Current API-retry status, or `null` when not retrying. */
  retry: RetryState | null;
  /**
   * Bookkeeping for {@link BackgroundTask.persistent}: `tool_use_id`s of Monitor
   * calls with `persistent: true` whose `task_started` hasn't arrived yet. Ids are
   * added when the assistant message carrying the `tool_use` block is folded and
   * consumed by the matching `task_started`. An id whose task never starts (the
   * tool call errors) lingers harmlessly until query teardown.
   */
  persistentMonitorToolUseIds: ReadonlySet<string>;
}

export const INITIAL_LIVE_STATUS: LiveStatus = {
  turnActive: false,
  backgroundTasks: new Map(),
  retry: null,
  persistentMonitorToolUseIds: new Set(),
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

/**
 * SDK `task_type` for a backgrounded Bash command — the task kind most likely to be
 * a permanently-running daemon (a dev server, a database, a supervisor) with no
 * self-determined end state; the model backgrounds it and it may run until the
 * session is torn down. The other kinds settle on their own and emit a terminal
 * `task_notification`: subagents (`local_agent`/`remote_agent`) and workflows
 * (`local_workflow`) run to completion, and Monitor watches (`monitor`) carry a
 * hard deadline (`timeout_ms`, default 5 min, max 1 h) — except `persistent: true`
 * monitors, which are session-length by design and tracked via
 * {@link BackgroundTask.persistent}.
 */
const BACKGROUND_BASH_TASK_TYPE = 'local_bash';

/**
 * Whether a background task should count toward the "is the agent still working?"
 * status axis — i.e. whether it has a knowable end state.
 *
 * Two kinds are EXCLUDED, because they may never emit a `task_notification` and
 * counting them would pin the session in the "background" state and suppress the
 * "Claude finished" notification forever (until teardown):
 * - a backgrounded Bash command (`local_bash`) — may be a permanent daemon;
 * - a `persistent: true` Monitor watch — session-length by design (its `timeout_ms`
 *   deadline is ignored), detected from the Monitor `tool_use` input.
 *
 * Everything else — subagents, deadline-bounded Monitor watches, workflows, and any
 * task with an unknown/absent `task_type` — counts. This gates ONLY the
 * background-vs-waiting badge and the finished notification; excluded tasks still
 * appear in the stoppable background-task list (`getBackgroundTasks`) so the user
 * can see and ✕-stop them.
 *
 * One accepted imperfection (the `task_type` is the best signal the SDK gives us —
 * a daemon is indistinguishable from a finite command at `task_started` time): a
 * FINITE backgrounded Bash (a long build/test run) is also excluded, so a turn
 * ending while one runs notifies "finished" early. Self-correcting: when the task
 * settles the main agent auto-continues, and that turn's end notifies again.
 */
export function taskHasEndState(task: BackgroundTask): boolean {
  return task.taskType !== BACKGROUND_BASH_TASK_TYPE && !task.persistent;
}

/**
 * Whether any background task with a knowable end state is currently running (see
 * {@link taskHasEndState}). Permanently-backgroundable Bash daemons are ignored, so
 * a session running only a dev server reads as idle for the badge/notification.
 */
export function backgroundActive(status: LiveStatus): boolean {
  for (const task of status.backgroundTasks.values()) {
    if (taskHasEndState(task)) return true;
  }
  return false;
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
        // Overridden in the reducer when the tool_use_id links back to a
        // persistent Monitor call (see persistentMonitorToolUseIds).
        persistent: false,
      },
    };
  }
  if (m.subtype === 'task_notification') {
    return { kind: 'settled', taskId: m.task_id };
  }
  return null;
}

/**
 * `tool_use` ids of `persistent: true` Monitor calls in a complete assistant
 * message, or `null` when there are none. The Monitor's input (where the
 * `persistent` flag lives) only exists on the `tool_use` block — the later
 * `task_started` carries just the `tool_use_id` — so the reducer remembers these
 * ids to flag the task when it starts. Scans ALL assistant messages (not just
 * top-level): a subagent can start a Monitor too, and `tool_use_id`s are globally
 * unique.
 */
function parsePersistentMonitorCalls(message: SDKMessage): string[] | null {
  if (message.type !== 'assistant') return null;
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return null;
  let ids: string[] | null = null;
  for (const block of content) {
    const b = block as {
      type?: string;
      id?: string;
      name?: string;
      input?: { persistent?: unknown };
    };
    if (
      b?.type === 'tool_use' &&
      b.name === 'Monitor' &&
      b.input?.persistent === true &&
      typeof b.id === 'string'
    ) {
      (ids ??= []).push(b.id);
    }
  }
  return ids;
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
  let { turnActive, backgroundTasks, retry, persistentMonitorToolUseIds } = prev;
  const topLevel = isTopLevel(message);

  // --- retry (turn-scoped) ---
  const parsedRetry = parseRetryState(message);
  if (parsedRetry) {
    retry = parsedRetry;
  } else if (topLevel) {
    retry = null;
  }

  // --- persistent-Monitor calls (remembered until their task_started arrives) ---
  const persistentCalls = parsePersistentMonitorCalls(message);
  if (persistentCalls) {
    const next = new Set(persistentMonitorToolUseIds);
    for (const id of persistentCalls) next.add(id);
    persistentMonitorToolUseIds = next;
  }

  // --- background tasks ---
  const bg = parseBackgroundTaskEvent(message);
  if (bg?.kind === 'started') {
    const persistent =
      bg.task.toolUseId !== undefined && persistentMonitorToolUseIds.has(bg.task.toolUseId);
    if (persistent) {
      // Consume the id — the linkage is one-shot.
      const next = new Set(persistentMonitorToolUseIds);
      next.delete(bg.task.toolUseId!);
      persistentMonitorToolUseIds = next;
    }
    const next = new Map(backgroundTasks);
    next.set(bg.task.taskId, { ...bg.task, persistent });
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
    status: { turnActive, backgroundTasks, retry, persistentMonitorToolUseIds },
    changed: {
      turnActive: turnActive !== prev.turnActive,
      background: backgroundTasks !== prev.backgroundTasks,
      retry: !retryEquals(retry, prev.retry),
    },
  };
}
