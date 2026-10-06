/**
 * Claude Code Message Types
 *
 * Zod schemas for the Claude Code messages we parse, plus the
 * classification/retry helpers used by the runner and UI.
 */

import { z } from 'zod';
import type { SDKMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';

/**
 * System init message content
 */
export const SystemInitContentSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string(),
  terminal_slash_commands: z.array(z.string()).optional(),
});

/** A `commands_changed` message: the full slash-command list, replacing the cached one. */
export const CommandsChangedContentSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('commands_changed'),
  commands: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      argumentHint: z.string(),
      aliases: z.array(z.string()).optional(),
      builtin: z.boolean().optional(),
    }) satisfies z.ZodType<SlashCommand>
  ),
});

/**
 * The Claude Code conversation a message says the CLI is now in, or null if it
 * doesn't say. Every query start (and every turn) emits an init; `/clear` emits
 * one carrying a brand-new id, which is what a later revive must resume. Not
 * `conversation_reset.new_conversation_id`: `/clear` sends that too, but with a
 * different id that has no transcript to resume.
 */
export function initSessionId(message: unknown): string | null {
  const parsed = SystemInitContentSchema.safeParse(message);
  return parsed.success ? parsed.data.session_id : null;
}

// =============================================================================
// Message Handling Types
// =============================================================================

/**
 * The four message types stored in the `Message.type` DB column.
 */
type DbMessageType = 'system' | 'user' | 'assistant' | 'result';

/**
 * How a streamed SDK message should be handled by the runner.
 * - `stream_event`: a partial-message delta, accumulated separately (not persisted)
 * - `skip`: a transient progress event with no durable content (dropped)
 * - `persist`: a complete message stored under `dbType`
 */
export type MessageHandling =
  { kind: 'stream_event' } | { kind: 'skip' } | { kind: 'persist'; dbType: DbMessageType };

/**
 * System message subtypes that carry no durable value — pure progress ticks or
 * internal state transitions. They are never persisted or shown.
 *
 * - `thinking_tokens`: live token-count estimates while Claude is thinking; the
 *   actual reasoning arrives in the assistant message's thinking content blocks.
 * - `task_progress`: cumulative progress ticks for a running subagent.
 * - `task_updated`: subagent state-merge patches.
 * - `background_tasks_changed`: the live background-task set, surfaced over the
 *   `background` SSE channel (see `reduceSessionMessage`).
 * - `hook_progress`: streaming hook output between `hook_started`/`hook_response`.
 * - `status`, `session_state_changed`: transient session/run state.
 * - `files_persisted`, `elicitation_complete`: internal bookkeeping events.
 * - `commands_changed`: slash-command list updates, applied by `session-commands`.
 * - `api_retry`: transient "retrying due to rate limit / overload" ticks. The
 *   live attempt count is surfaced ephemerally via the `retry` SSE channel (see
 *   {@link parseRetryState}); persisting each one would pollute the transcript
 *   with notices that carry no value once the request recovers.
 *
 * Without this filter each would render as an empty "System" bubble.
 */
const IGNORED_SYSTEM_SUBTYPES = [
  'thinking_tokens',
  'task_progress',
  'task_updated',
  'background_tasks_changed',
  'hook_progress',
  'status',
  'session_state_changed',
  'files_persisted',
  'elicitation_complete',
  'commands_changed',
  'api_retry',
] as const;

/**
 * An `api_retry` system message: the SDK is retrying a failed API request
 * (typically a 429 rate limit or 529 overload). These are not persisted — the
 * latest attempt count is streamed live as ephemeral status (see
 * {@link parseRetryState}).
 */
const ApiRetryContentSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('api_retry'),
  attempt: z.number(),
  max_retries: z.number(),
  // The SDK sends `null` (not absent) for connection errors like timeouts that
  // had no HTTP response, so this must accept null — not just undefined — or the
  // whole parse fails and the retry indicator never shows for those.
  error_status: z.number().nullable().optional(),
  // A `SDKAssistantMessageError` code, e.g. "rate_limit" | "overloaded" | "server_error".
  error: z.string().optional(),
});

/**
 * Ephemeral "Claude is retrying" status surfaced over the `retry` SSE channel.
 * `null` means no retry is in progress (the request recovered or the turn ended).
 */
export interface RetryState {
  /** 1-based attempt number for the in-flight retry. */
  attempt: number;
  /** Maximum attempts the SDK will make before giving up. */
  maxRetries: number;
  /** HTTP status that triggered the retry (e.g. 429, 529), if known. */
  errorStatus?: number;
  /** Short error code from the API (e.g. "overloaded"), if known. */
  error?: string;
}

/**
 * Extract {@link RetryState} from an SDK message, or `null` if it is not an
 * `api_retry` message.
 */
export function parseRetryState(message: unknown): RetryState | null {
  // Cheap subtype guard before the full Zod parse: this runs on every message in
  // the streaming loop (including high-frequency token deltas), and only
  // `api_retry` frames can ever match.
  if (
    typeof message !== 'object' ||
    message === null ||
    (message as { subtype?: unknown }).subtype !== 'api_retry'
  ) {
    return null;
  }
  const parsed = ApiRetryContentSchema.safeParse(message);
  if (!parsed.success) return null;
  return {
    attempt: parsed.data.attempt,
    maxRetries: parsed.data.max_retries,
    // Collapse the SDK's null (connection error, no HTTP response) to undefined.
    errorStatus: parsed.data.error_status ?? undefined,
    error: parsed.data.error,
  };
}

/** Friendly labels for the API error codes that actually trigger retries. */
const RETRY_REASON_LABELS: Record<string, string> = {
  overloaded: 'overloaded',
  rate_limit: 'rate limited',
  server_error: 'server error',
};

/**
 * Human-readable reason for an in-flight retry (e.g. "overloaded", "rate
 * limited"), or `null` if none can be determined. Prefers the SDK's canonical
 * `error` code, falling back to the HTTP status, then a humanized code.
 */
export function formatRetryReason(retry: RetryState): string | null {
  if (retry.error && RETRY_REASON_LABELS[retry.error]) {
    return RETRY_REASON_LABELS[retry.error];
  }
  if (retry.errorStatus === 529) return 'overloaded';
  if (retry.errorStatus === 429) return 'rate limited';
  // Humanize any other known code (e.g. "model_not_found" → "model not found").
  if (retry.error && retry.error !== 'unknown') return retry.error.replace(/_/g, ' ');
  return null;
}

/**
 * Delivery lifecycle of one user message we pushed into the streaming query.
 *
 * The CLI emits these for every user message stamped with a `uuid`, but the type
 * is absent from the SDK's `SDKMessage` union (`@anthropic-ai/claude-agent-sdk`
 * 0.3.219), so it is parsed defensively instead of typed. `state` is left open
 * (`string`) for the same reason: only `'queued'` — accepted into the CLI's
 * command queue but not yet handed to the model — is load-bearing, and anything
 * else means the message has left the queue.
 */
const CommandLifecycleSchema = z.object({
  type: z.literal('command_lifecycle'),
  command_uuid: z.string().min(1),
  state: z.string().min(1),
});
export type CommandLifecycle = z.infer<typeof CommandLifecycleSchema>;

/**
 * Parse a `command_lifecycle` message, or `null` for anything else. The observed
 * sequence for a delivered message is `queued` → `started` → `completed`;
 * `started` is the moment the agent actually sees it.
 */
export function parseCommandLifecycle(message: unknown): CommandLifecycle | null {
  const parsed = CommandLifecycleSchema.safeParse(message);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether a system message should be dropped entirely (never persisted or shown).
 * Operates on loosely-typed content so it can also filter rows stored before a
 * subtype was added to the ignore list (see {@link classifyMessage} for the typed
 * SDK path).
 */
export function isIgnoredSystemMessage(content: unknown): boolean {
  if (!content || typeof content !== 'object') return false;
  const obj = content as Record<string, unknown>;
  if (obj.type !== 'system') return false;
  // The SDK flags ambient/housekeeping tasks with skip_transcript so consumers
  // hide them from the inline transcript.
  if (obj.skip_transcript === true) return true;
  return (
    typeof obj.subtype === 'string' &&
    (IGNORED_SYSTEM_SUBTYPES as readonly string[]).includes(obj.subtype)
  );
}

/**
 * Compile-time exhaustiveness guard that stays safe at runtime.
 *
 * Passing a non-`never` value is a type error, so this fails to compile if a
 * `switch` misses a case (e.g. a newer SDK adds a `SDKMessage` variant). At
 * runtime it returns `fallback` rather than throwing, so an unexpected message
 * degrades gracefully instead of crashing the query loop.
 */
export function assertNeverFallback<T>(_unhandled: never, fallback: T): T {
  return fallback;
}

/**
 * Whether a message is the CLI's replay of a prompt we pushed. Other replays
 * (slash-command output, messages from other sessions) are real transcript
 * content.
 */
export function isEchoOfPushedPrompt(
  message: SDKMessage,
  pushedUuids: ReadonlySet<string>
): boolean {
  return (
    message.type === 'user' &&
    'isReplay' in message &&
    message.isReplay === true &&
    pushedUuids.has(message.uuid)
  );
}

/** Origin of a user message another session (`peer`) or an MCP channel injected. */
const InjectedOriginSchema = z.object({
  kind: z.enum(['peer', 'channel']),
  /** Sender's display name. */
  name: z.string().optional(),
  /** Sender's socket address. */
  from: z.string().optional(),
  /** Channel MCP server name. */
  server: z.string().optional(),
  /** Message text with the CLI's envelope stripped. */
  body: z.string().optional(),
});

export interface InjectedMessageOrigin {
  sender: string;
  body: string | null;
}

export function parseInjectedOrigin(origin: unknown): InjectedMessageOrigin | null {
  const parsed = InjectedOriginSchema.safeParse(origin);
  if (!parsed.success) return null;
  const { name, from, server, body } = parsed.data;
  return { sender: name ?? server ?? from ?? 'another session', body: body ?? null };
}

/**
 * Decide how to handle a message yielded by the Claude Agent SDK.
 *
 * Driven by the SDK's `SDKMessage` discriminated union: the `switch` is
 * exhaustive over the top-level `type`, so a message type added by a future SDK
 * release fails to compile here (via {@link assertNeverFallback}) until it is
 * explicitly handled. New `system` *subtypes* are intentionally not exhaustive —
 * unknown ones default to being persisted as a generic system message.
 */
export function classifyMessage(message: SDKMessage): MessageHandling {
  // `command_lifecycle` is emitted by the CLI but missing from `SDKMessage`, so it
  // would otherwise fall through to the `default` branch and be persisted as a
  // system bubble. It is pure delivery bookkeeping — never transcript content.
  if (parseCommandLifecycle(message)) return { kind: 'skip' };

  switch (message.type) {
    case 'assistant':
      return { kind: 'persist', dbType: 'assistant' };
    case 'user':
      return { kind: 'persist', dbType: 'user' };
    case 'result':
      return { kind: 'persist', dbType: 'result' };
    case 'stream_event':
      return { kind: 'stream_event' };
    case 'system':
      return isIgnoredSystemMessage(message)
        ? { kind: 'skip' }
        : { kind: 'persist', dbType: 'system' };
    case 'tool_progress':
    case 'tool_use_summary':
    case 'auth_status':
    case 'rate_limit_event':
    case 'prompt_suggestion':
      return { kind: 'persist', dbType: 'system' };
    case 'conversation_reset':
      // Internal SDK lifecycle signal (the conversation was reset to a new
      // conversation id). Carries no transcript value — like session_state_changed,
      // it is dropped rather than persisted so it never renders a system bubble.
      return { kind: 'skip' };
    default:
      return assertNeverFallback(message, { kind: 'persist', dbType: 'system' });
  }
}

/**
 * The tool_use id of the Task that spawned this message, or null for a top-level
 * (main-agent) message. Subagent messages carry `parent_tool_use_id`.
 */
export function getParentToolUseId(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const parent = (content as Record<string, unknown>).parent_tool_use_id;
  return typeof parent === 'string' ? parent : null;
}
