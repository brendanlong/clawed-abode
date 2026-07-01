/**
 * Claude Code Message Types
 *
 * This module provides typed parsing for all message types from Claude Code's
 * stream-json output format. Uses Zod for runtime validation.
 */

import { z } from 'zod';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// =============================================================================
// Content Block Schemas
// =============================================================================

/**
 * Text content block in an assistant message
 */
export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

/**
 * Thinking content block - represents Claude's extended-thinking reasoning.
 * `signature` is present on summarized thinking and absent while streaming.
 */
export const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
});
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;

/**
 * Redacted thinking block - thinking that the API encrypted rather than returning.
 * Carries no human-readable text, only opaque `data`.
 */
export const RedactedThinkingBlockSchema = z.object({
  type: z.literal('redacted_thinking'),
  data: z.string(),
});
export type RedactedThinkingBlock = z.infer<typeof RedactedThinkingBlockSchema>;

/**
 * Tool use content block - represents a tool call by the assistant
 */
export const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;

/**
 * Tool result content block - represents the result of a tool call
 */
export const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.string().optional(),
  is_error: z.boolean().optional(),
});
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;

/**
 * Server tool use content block - a tool executed server-side by the Anthropic
 * API (e.g. the advisor tool). Unlike `tool_use` it never goes through
 * canUseTool, and its result arrives as a dedicated block type rather than a
 * `tool_result` in a user message.
 */
export const ServerToolUseBlockSchema = z.object({
  type: z.literal('server_tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
export type ServerToolUseBlock = z.infer<typeof ServerToolUseBlockSchema>;

/**
 * Advisor tool result block - the advisor's response to a `server_tool_use`
 * advisor call. The content is encrypted (`advisor_redacted_result`) and only
 * readable by the model, so it carries nothing renderable.
 */
export const AdvisorToolResultBlockSchema = z.object({
  type: z.literal('advisor_tool_result'),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
});
export type AdvisorToolResultBlock = z.infer<typeof AdvisorToolResultBlockSchema>;

/**
 * Union of all content block types
 */
export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ServerToolUseBlockSchema,
  AdvisorToolResultBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

// =============================================================================
// Usage Schemas
// =============================================================================

/**
 * Cache creation info
 */
export const CacheCreationSchema = z.object({
  ephemeral_5m_input_tokens: z.number().optional(),
  ephemeral_1h_input_tokens: z.number().optional(),
});
export type CacheCreation = z.infer<typeof CacheCreationSchema>;

/**
 * Usage statistics for a single message
 */
export const MessageUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation: CacheCreationSchema.optional(),
  service_tier: z.string().optional(),
});
export type MessageUsage = z.infer<typeof MessageUsageSchema>;

/**
 * Usage stats for a specific model in result messages
 */
export const ModelUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
  webSearchRequests: z.number().optional(),
  costUSD: z.number().optional(),
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().optional(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

/**
 * Server tool use stats
 */
export const ServerToolUseSchema = z.object({
  web_search_requests: z.number().optional(),
  web_fetch_requests: z.number().optional(),
});
export type ServerToolUse = z.infer<typeof ServerToolUseSchema>;

/**
 * Aggregated usage for result messages.
 * Per the Anthropic Agent SDK, result messages use NonNullableUsage where
 * all fields are required numbers. We keep them optional in our schema for
 * backwards compatibility with older stored messages.
 */
export const ResultUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  server_tool_use: ServerToolUseSchema.optional(),
  service_tier: z.string().optional(),
  cache_creation: CacheCreationSchema.optional(),
  inference_geo: z.string().nullable().optional(),
  speed: z.enum(['standard', 'fast']).nullable().optional(),
});
export type ResultUsage = z.infer<typeof ResultUsageSchema>;

// =============================================================================
// Inner Message Schemas
// =============================================================================

/**
 * The inner message object from the API response
 */
export const ApiMessageSchema = z.object({
  model: z.string().optional(),
  id: z.string().optional(),
  type: z.literal('message').optional(),
  role: z.enum(['assistant', 'user']),
  content: z.array(ContentBlockSchema),
  stop_reason: z.string().nullable().optional(),
  stop_sequence: z.string().nullable().optional(),
  usage: MessageUsageSchema.optional(),
  context_management: z.unknown().nullable().optional(),
});
export type ApiMessage = z.infer<typeof ApiMessageSchema>;

// =============================================================================
// Message Content Schemas (outer wrapper)
// =============================================================================

/**
 * Assistant message content
 */
export const AssistantContentSchema = z.object({
  type: z.literal('assistant'),
  message: ApiMessageSchema,
  parent_tool_use_id: z.string().nullable().optional(),
  session_id: z.string(),
  uuid: z.string(),
});
export type AssistantContent = z.infer<typeof AssistantContentSchema>;

/**
 * User message content (can contain tool results)
 */
export const UserContentSchema = z.object({
  type: z.literal('user'),
  message: z.object({
    role: z.literal('user'),
    content: z.array(ContentBlockSchema),
  }),
  parent_tool_use_id: z.string().nullable().optional(),
  session_id: z.string(),
  uuid: z.string(),
  tool_use_result: z.unknown().optional(),
});
export type UserContent = z.infer<typeof UserContentSchema>;

/**
 * System init message content
 */
export const SystemInitContentSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  cwd: z.string(),
  session_id: z.string(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z.array(z.unknown()).optional(),
  model: z.string(),
  permissionMode: z.string().optional(),
  slash_commands: z.array(z.string()).optional(),
  apiKeySource: z.string().optional(),
  claude_code_version: z.string().optional(),
  output_style: z.string().optional(),
  agents: z.array(z.string()).optional(),
  skills: z.array(z.unknown()).optional(),
  plugins: z.array(z.unknown()).optional(),
  uuid: z.string().optional(),
});
export type SystemInitContent = z.infer<typeof SystemInitContentSchema>;

/**
 * System error message content - can contain embedded JSON with tool results
 */
export const SystemErrorContentSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('error'),
  content: z.array(
    z.object({
      type: z.literal('text'),
      text: z.string(),
    })
  ),
});
export type SystemErrorContent = z.infer<typeof SystemErrorContentSchema>;

/**
 * Compact boundary message content - emitted when /compact is used or auto-compaction triggers
 */
export const SystemCompactBoundaryContentSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('compact_boundary'),
  compact_metadata: z.object({
    trigger: z.enum(['manual', 'auto']),
    pre_tokens: z.number(),
  }),
  uuid: z.string(),
  session_id: z.string(),
});
export type SystemCompactBoundaryContent = z.infer<typeof SystemCompactBoundaryContentSchema>;

/**
 * Generic system content (for other subtypes like status, hook_started, hook_response, etc.)
 * Uses passthrough() to preserve all properties from the original message, since different
 * system subtypes have varying fields (e.g., hook_id, status, task_id, etc.).
 */
export const SystemGenericContentSchema = z
  .object({
    type: z.literal('system'),
    subtype: z.string().optional(),
    content: z.unknown().optional(),
  })
  .passthrough();
export type SystemGenericContent = z.infer<typeof SystemGenericContentSchema>;

/**
 * Permission denial info from result messages
 */
export const PermissionDenialSchema = z.object({
  tool_name: z.string().optional(),
  tool_use_id: z.string().optional(),
  tool_input: z.unknown().optional(),
});
export type PermissionDenial = z.infer<typeof PermissionDenialSchema>;

/**
 * Result message content (session completion)
 * Handles all SDK result subtypes: success, error_max_turns, error_during_execution,
 * error_max_budget_usd, error_max_structured_output_retries
 */
export const ResultContentSchema = z.object({
  type: z.literal('result'),
  subtype: z.enum([
    'success',
    'error',
    'error_max_turns',
    'error_during_execution',
    'error_max_budget_usd',
    'error_max_structured_output_retries',
  ]),
  is_error: z.boolean(),
  duration_ms: z.number().optional(),
  duration_api_ms: z.number().optional(),
  num_turns: z.number().optional(),
  stop_reason: z.string().nullable().optional(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  session_id: z.string(),
  total_cost_usd: z.number().optional(),
  usage: ResultUsageSchema.optional(),
  modelUsage: z.record(z.string(), ModelUsageSchema).optional(),
  permission_denials: z.array(PermissionDenialSchema).optional(),
  structured_output: z.unknown().optional(),
  uuid: z.string().optional(),
});
export type ResultContent = z.infer<typeof ResultContentSchema>;

// =============================================================================
// Database Message Schemas (what we store and retrieve)
// =============================================================================

/**
 * Schema for messages as stored in the database
 */
export const StoredMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  sequence: z.number(),
  type: z.enum(['system', 'user', 'assistant', 'result']),
  content: z.unknown(), // JSON content varies by type
  createdAt: z.date().or(z.string().transform((s) => new Date(s))),
});
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

// =============================================================================
// Parsed Message Classes
// =============================================================================

/**
 * Base class for all parsed messages
 */
export abstract class ParsedMessage {
  constructor(
    public readonly id: string,
    public readonly sessionId: string,
    public readonly sequence: number,
    public readonly createdAt: Date
  ) {}

  abstract get messageType(): 'system' | 'user' | 'assistant' | 'result';
}

/**
 * Parsed assistant message
 */
export class AssistantMessage extends ParsedMessage {
  readonly messageType = 'assistant' as const;

  constructor(
    id: string,
    sessionId: string,
    sequence: number,
    createdAt: Date,
    public readonly content: AssistantContent
  ) {
    super(id, sessionId, sequence, createdAt);
  }

  /** Get all text content concatenated */
  getText(): string {
    return this.content.message.content
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  /** Get all tool use blocks */
  getToolUses(): ToolUseBlock[] {
    return this.content.message.content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use'
    );
  }

  /** Get the model used */
  get model(): string | undefined {
    return this.content.message.model;
  }

  /** Get token usage */
  get usage(): MessageUsage | undefined {
    return this.content.message.usage;
  }
}

/**
 * Parsed user message (often contains tool results)
 */
export class UserMessage extends ParsedMessage {
  readonly messageType = 'user' as const;

  constructor(
    id: string,
    sessionId: string,
    sequence: number,
    createdAt: Date,
    public readonly content: UserContent
  ) {
    super(id, sessionId, sequence, createdAt);
  }

  /** Check if this is a tool result message */
  isToolResult(): boolean {
    return this.content.message.content.some((block) => block.type === 'tool_result');
  }

  /** Get all tool result blocks */
  getToolResults(): ToolResultBlock[] {
    return this.content.message.content.filter(
      (block): block is ToolResultBlock => block.type === 'tool_result'
    );
  }

  /** Build a map of tool_use_id -> result for matching with tool uses */
  getToolResultMap(): Map<string, { content?: string; is_error?: boolean }> {
    const map = new Map<string, { content?: string; is_error?: boolean }>();
    for (const result of this.getToolResults()) {
      map.set(result.tool_use_id, {
        content: result.content,
        is_error: result.is_error,
      });
    }
    return map;
  }
}

/**
 * Parsed system message
 */
export class SystemMessage extends ParsedMessage {
  readonly messageType = 'system' as const;

  constructor(
    id: string,
    sessionId: string,
    sequence: number,
    createdAt: Date,
    public readonly content:
      | SystemInitContent
      | SystemErrorContent
      | SystemCompactBoundaryContent
      | SystemGenericContent
  ) {
    super(id, sessionId, sequence, createdAt);
  }

  /** Check if this is an init message */
  isInit(): this is SystemMessage & { content: SystemInitContent } {
    return this.content.subtype === 'init';
  }

  /** Check if this is an error message */
  isError(): this is SystemMessage & { content: SystemErrorContent } {
    return this.content.subtype === 'error';
  }

  /** Check if this is a compact boundary message */
  isCompactBoundary(): this is SystemMessage & { content: SystemCompactBoundaryContent } {
    return this.content.subtype === 'compact_boundary';
  }

  /** Get error text if this is an error message */
  getErrorText(): string | undefined {
    if (!this.isError()) return undefined;
    const errorContent = this.content as SystemErrorContent;
    return errorContent.content.map((c) => c.text).join('\n');
  }

  /** Get session info if this is an init message */
  getInitInfo():
    | {
        model: string;
        cwd: string;
        tools?: string[];
        version?: string;
      }
    | undefined {
    if (!this.isInit()) return undefined;
    const initContent = this.content as SystemInitContent;
    return {
      model: initContent.model,
      cwd: initContent.cwd,
      tools: initContent.tools,
      version: initContent.claude_code_version,
    };
  }

  /** Get compact metadata if this is a compact boundary message */
  getCompactInfo():
    | {
        trigger: 'manual' | 'auto';
        preTokens: number;
      }
    | undefined {
    if (!this.isCompactBoundary()) return undefined;
    const compactContent = this.content as SystemCompactBoundaryContent;
    return {
      trigger: compactContent.compact_metadata.trigger,
      preTokens: compactContent.compact_metadata.pre_tokens,
    };
  }
}

/**
 * Parsed result message (session completion)
 */
export class ResultMessage extends ParsedMessage {
  readonly messageType = 'result' as const;

  constructor(
    id: string,
    sessionId: string,
    sequence: number,
    createdAt: Date,
    public readonly content: ResultContent
  ) {
    super(id, sessionId, sequence, createdAt);
  }

  /** Check if the session completed successfully */
  get isSuccess(): boolean {
    return this.content.subtype === 'success' && !this.content.is_error;
  }

  /** Get the result text */
  get resultText(): string | undefined {
    return this.content.result;
  }

  /** Get total cost in USD */
  get costUsd(): number | undefined {
    return this.content.total_cost_usd;
  }

  /** Get duration in milliseconds */
  get durationMs(): number | undefined {
    return this.content.duration_ms;
  }

  /** Get number of turns */
  get numTurns(): number | undefined {
    return this.content.num_turns;
  }

  /** Get aggregated usage stats */
  get usage(): ResultUsage | undefined {
    return this.content.usage;
  }
}

/**
 * Raw/unknown message - used for messages that fail validation or are unknown types
 * These should be displayed as collapsed JSON in the UI
 */
export class RawMessage extends ParsedMessage {
  readonly messageType = 'system' as const; // Treat as system for display purposes

  constructor(
    id: string,
    sessionId: string,
    sequence: number,
    createdAt: Date,
    public readonly rawContent: unknown,
    public readonly parseError?: string
  ) {
    super(id, sessionId, sequence, createdAt);
  }

  /** Get the raw content as a formatted JSON string */
  getFormattedJson(): string {
    try {
      return JSON.stringify(this.rawContent, null, 2);
    } catch {
      return String(this.rawContent);
    }
  }

  /** Check if this was a parse error vs just unknown type */
  get isParseError(): boolean {
    return this.parseError !== undefined;
  }
}

// Union type for all parsed messages
export type AnyParsedMessage =
  | AssistantMessage
  | UserMessage
  | SystemMessage
  | ResultMessage
  | RawMessage;

// =============================================================================
// Parsing Functions
// =============================================================================

/**
 * Parse a stored message into a typed ParsedMessage
 * Returns RawMessage for unknown types or validation failures
 */
export function parseStoredMessage(stored: StoredMessage): AnyParsedMessage {
  const { id, sessionId, sequence, type, content, createdAt } = stored;
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);

  switch (type) {
    case 'assistant': {
      const parsed = AssistantContentSchema.safeParse(content);
      if (!parsed.success) {
        console.warn('Failed to parse assistant message:', parsed.error);
        return new RawMessage(
          id,
          sessionId,
          sequence,
          date,
          content,
          `Failed to parse assistant message: ${parsed.error.message}`
        );
      }
      return new AssistantMessage(id, sessionId, sequence, date, parsed.data);
    }

    case 'user': {
      const parsed = UserContentSchema.safeParse(content);
      if (!parsed.success) {
        console.warn('Failed to parse user message:', parsed.error);
        return new RawMessage(
          id,
          sessionId,
          sequence,
          date,
          content,
          `Failed to parse user message: ${parsed.error.message}`
        );
      }
      return new UserMessage(id, sessionId, sequence, date, parsed.data);
    }

    case 'system': {
      // Try specific schemas first, then fall back to generic
      const initParsed = SystemInitContentSchema.safeParse(content);
      if (initParsed.success) {
        return new SystemMessage(id, sessionId, sequence, date, initParsed.data);
      }

      const errorParsed = SystemErrorContentSchema.safeParse(content);
      if (errorParsed.success) {
        return new SystemMessage(id, sessionId, sequence, date, errorParsed.data);
      }

      const compactParsed = SystemCompactBoundaryContentSchema.safeParse(content);
      if (compactParsed.success) {
        return new SystemMessage(id, sessionId, sequence, date, compactParsed.data);
      }

      // Fall back to generic (handles status, hook_started, hook_response, etc.)
      const genericParsed = SystemGenericContentSchema.safeParse(content);
      if (genericParsed.success) {
        return new SystemMessage(id, sessionId, sequence, date, genericParsed.data);
      }

      // All system parsers failed - return raw
      console.warn('Failed to parse system message:', content);
      return new RawMessage(
        id,
        sessionId,
        sequence,
        date,
        content,
        'Failed to parse system message'
      );
    }

    case 'result': {
      const parsed = ResultContentSchema.safeParse(content);
      if (!parsed.success) {
        console.warn('Failed to parse result message:', parsed.error);
        return new RawMessage(
          id,
          sessionId,
          sequence,
          date,
          content,
          `Failed to parse result message: ${parsed.error.message}`
        );
      }
      return new ResultMessage(id, sessionId, sequence, date, parsed.data);
    }

    default: {
      // Unknown type - return raw message
      console.warn('Unknown message type:', type);
      return new RawMessage(
        id,
        sessionId,
        sequence,
        date,
        content,
        `Unknown message type: ${type}`
      );
    }
  }
}

/**
 * Result of parsing a Claude stream line
 */
export type StreamLineParseResult =
  | {
      success: true;
      data:
        | AssistantContent
        | UserContent
        | SystemInitContent
        | SystemErrorContent
        | SystemCompactBoundaryContent
        | SystemGenericContent
        | ResultContent;
    }
  | { success: false; raw: unknown; error: string };

/**
 * Parse raw JSON content from Claude Code stream.
 * Handles all known SDK message types including system subtypes
 * (init, error, compact_boundary, status, hooks) and non-system types
 * (tool_progress, tool_use_summary, auth_status).
 */
export function parseClaudeStreamLine(json: unknown): StreamLineParseResult {
  if (!json || typeof json !== 'object') {
    return { success: false, raw: json, error: 'Invalid JSON: expected object' };
  }

  const obj = json as Record<string, unknown>;
  const type = obj.type as string;

  switch (type) {
    case 'assistant': {
      const parsed = AssistantContentSchema.safeParse(json);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return {
        success: false,
        raw: json,
        error: `Failed to parse assistant: ${parsed.error.message}`,
      };
    }
    case 'user': {
      const parsed = UserContentSchema.safeParse(json);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return { success: false, raw: json, error: `Failed to parse user: ${parsed.error.message}` };
    }
    case 'system': {
      // Try specific schemas first, then fall back to generic
      const initParsed = SystemInitContentSchema.safeParse(json);
      if (initParsed.success) {
        return { success: true, data: initParsed.data };
      }

      const errorParsed = SystemErrorContentSchema.safeParse(json);
      if (errorParsed.success) {
        return { success: true, data: errorParsed.data };
      }

      const compactParsed = SystemCompactBoundaryContentSchema.safeParse(json);
      if (compactParsed.success) {
        return { success: true, data: compactParsed.data };
      }

      // Fall back to generic for other system subtypes (status, hook_started,
      // hook_response, hook_progress, files_persisted, task_notification)
      const genericParsed = SystemGenericContentSchema.safeParse(json);
      if (genericParsed.success) {
        return { success: true, data: genericParsed.data };
      }

      return { success: false, raw: json, error: 'Failed to parse system message' };
    }
    case 'result': {
      const parsed = ResultContentSchema.safeParse(json);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return {
        success: false,
        raw: json,
        error: `Failed to parse result: ${parsed.error.message}`,
      };
    }
    // Additional SDK message types that are not 'system' but are stored as system in DB
    case 'tool_progress':
    case 'tool_use_summary':
    case 'auth_status': {
      // These have their own top-level type in the SDK but are stored as 'system' in our DB.
      // Parse them as generic system content for forward compatibility.
      const genericParsed = SystemGenericContentSchema.safeParse({
        ...json,
        type: 'system',
        subtype: type,
      });
      if (genericParsed.success) {
        return { success: true, data: genericParsed.data };
      }
      return { success: false, raw: json, error: `Failed to parse ${type} message` };
    }
    default:
      return { success: false, raw: json, error: `Unknown message type: ${type}` };
  }
}

/**
 * The four message types stored in the `Message.type` DB column.
 */
export type DbMessageType = 'system' | 'user' | 'assistant' | 'result';

/**
 * How a streamed SDK message should be handled by the runner.
 * - `stream_event`: a partial-message delta, accumulated separately (not persisted)
 * - `skip`: a transient progress event with no durable content (dropped)
 * - `persist`: a complete message stored under `dbType`
 */
export type MessageHandling =
  | { kind: 'stream_event' }
  | { kind: 'skip' }
  | { kind: 'persist'; dbType: DbMessageType };

/**
 * System message subtypes that carry no durable value — pure progress ticks or
 * internal state transitions. They are never persisted or shown.
 *
 * - `thinking_tokens`: live token-count estimates while Claude is thinking; the
 *   actual reasoning arrives in the assistant message's thinking content blocks.
 * - `task_progress`: cumulative progress ticks for a running subagent.
 * - `task_updated`: subagent state-merge patches. Not persisted/shown, but note
 *   the live-status reducer still inspects it off the raw stream (it runs on every
 *   message, before classification): a terminal `patch.status` settles a background
 *   task, backstopping a missing/dropped `task_notification` (see
 *   `reduceSessionMessage` in `session-status.ts`).
 * - `hook_progress`: streaming hook output between `hook_started`/`hook_response`.
 * - `status`, `session_state_changed`: transient session/run state.
 * - `files_persisted`, `elicitation_complete`: internal bookkeeping events.
 * - `commands_changed`: slash-command list updates (not chat content).
 * - `api_retry`: transient "retrying due to rate limit / overload" ticks. The
 *   live attempt count is surfaced ephemerally via the `retry` SSE channel (see
 *   {@link parseRetryState}); persisting each one would pollute the transcript
 *   with notices that carry no value once the request recovers.
 *
 * Without this filter each would render as an empty "System" bubble.
 */
export const IGNORED_SYSTEM_SUBTYPES = [
  'thinking_tokens',
  'task_progress',
  'task_updated',
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
export const ApiRetryContentSchema = z.object({
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
 * Decide how to handle a message yielded by the Claude Agent SDK.
 *
 * Driven by the SDK's `SDKMessage` discriminated union: the `switch` is
 * exhaustive over the top-level `type`, so a message type added by a future SDK
 * release fails to compile here (via {@link assertNeverFallback}) until it is
 * explicitly handled. New `system` *subtypes* are intentionally not exhaustive —
 * unknown ones default to being persisted as a generic system message.
 */
export function classifyMessage(message: SDKMessage): MessageHandling {
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
    default:
      return assertNeverFallback(message, { kind: 'persist', dbType: 'system' });
  }
}

// =============================================================================
// Helper functions for working with messages
// =============================================================================

/**
 * Build a map of tool_use_id -> result from a list of messages
 * This matches tool_use blocks with their corresponding tool_result
 */
export function buildToolResultMap(
  messages: AnyParsedMessage[]
): Map<string, { content?: string; is_error?: boolean }> {
  const map = new Map<string, { content?: string; is_error?: boolean }>();

  for (const msg of messages) {
    if (msg instanceof UserMessage) {
      const results = msg.getToolResultMap();
      for (const [id, result] of results) {
        map.set(id, result);
      }
    }
  }

  return map;
}

/**
 * Get all tool use IDs from an assistant message
 */
export function getToolUseIds(msg: AssistantMessage): string[] {
  return msg.getToolUses().map((tu) => tu.id);
}

/**
 * Check if a message is a standalone tool result (not part of regular conversation)
 */
export function isStandaloneToolResult(msg: AnyParsedMessage): boolean {
  return msg instanceof UserMessage && msg.isToolResult();
}
