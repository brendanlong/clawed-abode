/**
 * Pure derivation of a session's live status from the SDK message stream: the
 * main-agent `turnActive` axis, the background-task axis, and the ephemeral
 * API-retry status. Why "busy" is two axes: doc/claude-sessions.md "Two-Axis
 * Status".
 *
 * A pure reducer, composed into the live-turn reducer (src/lib/live-turn.ts),
 * which also tracks delivery and interrupts.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { parseRetryState, type RetryState } from './claude-messages';

/** A live background task, as reported by the SDK's `background_tasks_changed`. */
export interface BackgroundTask {
  taskId: string;
  taskType: string;
  description: string;
  /** From the task's `task_started` (the level payload doesn't carry it). */
  subagentType?: string;
  /** The SDK says this task is not activity (housekeeping, live-update watchers). */
  ambient: boolean;
}

export interface LiveStatus {
  /** The main agent is mid-turn generating. */
  turnActive: boolean;
  /** Live background tasks by `task_id` (indicator only; never gates input). */
  backgroundTasks: ReadonlyMap<string, BackgroundTask>;
  /** Current API-retry status, or `null` when not retrying. */
  retry: RetryState | null;
  /**
   * `subagent_type` by `task_id`, recorded from `task_started` and dropped at the
   * task's `task_notification`. Kept apart from the set because the level payload
   * carries ids only and may arrive before or after the `task_started`.
   */
  subagentTypes: ReadonlyMap<string, string>;
}

export const INITIAL_LIVE_STATUS: LiveStatus = {
  turnActive: false,
  backgroundTasks: new Map(),
  retry: null,
  subagentTypes: new Map(),
};

/**
 * SDK `task_type` for a backgrounded Bash command — and for every `Monitor` watch,
 * which the CLI runs as a `local_bash` task. Either may run until the session is
 * torn down (a dev server, a `persistent: true` Monitor) with no self-determined
 * end state.
 */
export const BACKGROUND_BASH_TASK_TYPE = 'local_bash';

/**
 * Whether a background task should count toward the "is the agent still working?"
 * status axis — i.e. whether it has a knowable end state.
 *
 * EXCLUDED, because counting them would pin the session in the "background" state
 * until teardown:
 * - `ambient` tasks — the SDK's own "not activity" flag;
 * - `local_bash` tasks — backgrounded Bash and Monitor watches, which may be
 *   permanent daemons / session-length watches. The SDK does NOT mark a
 *   `persistent: true` Monitor ambient, so this check is what excludes it.
 *
 * This gates ONLY the background-vs-waiting badge; excluded tasks still appear in
 * the stoppable task list (the session stream's `backgroundTasks`). Accepted imperfection: a FINITE
 * backgrounded Bash is also excluded, so the session reads "waiting" while one runs.
 */
export function taskHasEndState(task: BackgroundTask): boolean {
  return !task.ambient && task.taskType !== BACKGROUND_BASH_TASK_TYPE;
}

/** Whether any background task with a knowable end state is running (see {@link taskHasEndState}). */
export function backgroundActive(status: LiveStatus): boolean {
  for (const task of status.backgroundTasks.values()) {
    if (taskHasEndState(task)) return true;
  }
  return false;
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

/**
 * System subtypes reporting on background tasks. They carry no
 * `parent_tool_use_id` but say nothing about the main agent's request.
 */
const BACKGROUND_TASK_SUBTYPES: ReadonlySet<string> = new Set([
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
  'background_tasks_changed',
]);

/** Whether a message is evidence the main agent's request is alive (so a retry is over). */
function isMainAgentTraffic(message: SDKMessage): boolean {
  if (!isTopLevel(message)) return false;
  return !(message.type === 'system' && BACKGROUND_TASK_SUBTYPES.has(message.subtype));
}

/** Whether a message is the main agent's `message_start` — the moment a turn visibly begins. */
export function isTopLevelMessageStart(message: SDKMessage): boolean {
  if (message.type !== 'stream_event' || !isTopLevel(message)) return false;
  return message.event?.type === 'message_start';
}

export function retryEquals(a: RetryState | null, b: RetryState | null): boolean {
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

const BackgroundTasksChangedSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('background_tasks_changed'),
  tasks: z.array(
    z.object({
      task_id: z.string(),
      task_type: z.string(),
      description: z.string(),
      ambient: z.boolean().optional(),
    })
  ),
});

/**
 * The full live background-task set from a `background_tasks_changed` level
 * signal, or `null` for any other message. REPLACE semantics: a missed edge can't
 * leave a stale task behind.
 */
function parseBackgroundTaskSet(
  message: SDKMessage,
  subagentTypes: ReadonlyMap<string, string>
): ReadonlyMap<string, BackgroundTask> | null {
  if (message.type !== 'system' || message.subtype !== 'background_tasks_changed') return null;
  const parsed = BackgroundTasksChangedSchema.safeParse(message);
  if (!parsed.success) return null;
  return new Map(
    parsed.data.tasks.map((t) => [
      t.task_id,
      {
        taskId: t.task_id,
        taskType: t.task_type,
        description: t.description,
        subagentType: subagentTypes.get(t.task_id),
        ambient: t.ambient === true,
      },
    ])
  );
}

/**
 * Fold one SDK message into the live status. Pure: returns the next status and
 * whether the turn axis moved.
 *
 * - `turnActive`: a top-level `message_start` sets it; a top-level `message_delta`
 *   whose `stop_reason` is terminal (`end_turn`/`stop_sequence`/`max_tokens`/
 *   `refusal`) clears it, and a top-level `result` clears it as a backstop (why
 *   not `result` alone: doc/claude-sessions.md "Two-Axis Status"). Subagent
 *   (`parent_tool_use_id != null`) traffic never moves it. NOTE: the stream-driven
 *   path relies on `includePartialMessages: true` (the runner hard-enables it) so the
 *   terminal `message_delta` arrives; without partials only the `result` backstop
 *   would clear it.
 * - background tasks: each `background_tasks_changed` replaces the set. The
 *   `task_started` / `task_notification` edges only maintain `subagentTypes`,
 *   which each set also prunes to its members.
 * - retry: an `api_retry` message sets it; any other main-agent message clears it
 *   (the main request recovered). Background traffic — subagent messages and the
 *   top-level background-task system events (`task_progress` etc.) — leaves retry
 *   untouched, so it can't prematurely clear a main-turn retry indicator.
 */
export function reduceSessionMessage(prev: LiveStatus, message: SDKMessage): LiveStatus {
  let { turnActive, backgroundTasks, retry, subagentTypes } = prev;
  const topLevel = isTopLevel(message);

  // --- retry (turn-scoped) ---
  const parsedRetry = parseRetryState(message);
  if (parsedRetry) {
    retry = parsedRetry;
  } else if (isMainAgentTraffic(message)) {
    retry = null;
  }

  // --- background tasks ---
  if (message.type === 'system') {
    if (message.subtype === 'task_started' && message.subagent_type) {
      const subagentType = message.subagent_type;
      subagentTypes = new Map(subagentTypes).set(message.task_id, subagentType);
      // The level may have listed this task before its task_started arrived.
      const task = backgroundTasks.get(message.task_id);
      if (task) {
        backgroundTasks = new Map(backgroundTasks).set(task.taskId, { ...task, subagentType });
      }
    } else if (message.subtype === 'task_notification' && subagentTypes.has(message.task_id)) {
      const next = new Map(subagentTypes);
      next.delete(message.task_id);
      subagentTypes = next;
    }
  }
  const taskSet = parseBackgroundTaskSet(message, subagentTypes);
  if (taskSet) {
    backgroundTasks = taskSet;
    // Foreground subagents never enter the set and may never send a
    // task_notification, so forget any type the latest set doesn't list.
    if ([...subagentTypes.keys()].some((id) => !taskSet.has(id))) {
      subagentTypes = new Map([...subagentTypes].filter(([id]) => taskSet.has(id)));
    }
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

  return { turnActive, backgroundTasks, retry, subagentTypes };
}
