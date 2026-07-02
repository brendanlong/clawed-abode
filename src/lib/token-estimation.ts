/**
 * Token usage estimation utilities
 *
 * Estimates context window usage and total session cost from Claude Code messages.
 *
 * SDK result-message semantics (verified empirically against real sessions):
 *
 * - The top-level `usage` on a result message is PER-TURN — the tokens consumed
 *   by the turn that just completed. Summing it across result messages is correct.
 * - `total_cost_usd` and `modelUsage` are CUMULATIVE since the query process
 *   started. With the persistent per-session query, one process spans many turns,
 *   so every result repeats (and extends) the totals of the results before it.
 *   The counters reset to zero when the query is re-established (stop/start,
 *   server restart) — `resume` does not carry cost forward.
 *
 * Cost is therefore aggregated by segmenting the result messages into query
 * processes and summing the final cumulative value of each segment. Segment
 * boundaries are detected by the cumulative cost decreasing: it is monotonically
 * non-decreasing within a process, so a drop means the counter reset.
 *
 * The "context usage %" reflects how full the context window currently is, NOT
 * the total tokens consumed: it uses the most recent top-level (main-agent)
 * assistant message's prompt size (input + cache read + cache creation) plus its
 * output tokens (which become input in the next call). Subagent messages are
 * skipped — they run in their own, smaller context.
 */

import { z } from 'zod';

// Default context window size, used until a result message reports the real one
// via modelUsage.contextWindow (e.g. 1M for [1m] models).
const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Structure representing token usage and context window occupancy
 */
export interface TokenUsageStats {
  /** Total input tokens consumed across all API calls (for cost tracking) */
  inputTokens: number;
  /** Total output tokens consumed across all API calls (for cost tracking) */
  outputTokens: number;
  /** Total cache read tokens across all API calls */
  cacheReadTokens: number;
  /** Total cache creation tokens across all API calls */
  cacheCreationTokens: number;
  /** Total tokens consumed (input + output, for cost tracking) */
  totalTokens: number;
  /** Model's context window capacity */
  contextWindow: number;
  /** Percentage of context window currently occupied (based on most recent API call) */
  percentUsed: number;
  /** Detected model name */
  model?: string;
  /**
   * Total session cost in USD, aggregated from the authoritative (cumulative
   * per query process) total_cost_usd on result messages.
   */
  totalCostUsd: number;
}

/**
 * Zod schema for the `usage` object on assistant and result messages
 */
const MessageUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
});

/**
 * Schema for system init content that may contain model info
 */
const SystemInitSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  model: z.string().optional(),
});

/**
 * Schema for assistant message content
 */
const AssistantContentSchema = z.object({
  type: z.literal('assistant'),
  parent_tool_use_id: z.string().nullable().optional(),
  message: z.object({
    id: z.string().optional(),
    usage: MessageUsageSchema.optional(),
    model: z.string().optional(),
  }),
});

/**
 * Schema for result message content. Only contextWindow is read from
 * modelUsage — its token counts and costUSD are cumulative per query process,
 * so they must not be summed across results.
 */
const ResultContentSchema = z.object({
  type: z.literal('result'),
  total_cost_usd: z.number().optional(),
  usage: MessageUsageSchema.optional(),
  modelUsage: z.record(z.string(), z.object({ contextWindow: z.number().optional() })).optional(),
});

/**
 * Message structure expected by the estimation function.
 * Messages must be provided in chronological order (oldest first).
 */
interface Message {
  type: string;
  content: unknown;
}

interface ExtractedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function extractUsageTokens(usage: z.infer<typeof MessageUsageSchema>): ExtractedUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Extract usage from an assistant message.
 * Returns the message id for deduplication — per the Anthropic docs, multiple
 * assistant messages in the same step share the same id and identical usage.
 * We should only count usage once per unique message id.
 */
function extractAssistantUsage(content: unknown): {
  messageId?: string;
  usage: ExtractedUsage;
  model?: string;
  isTopLevel: boolean;
} | null {
  const parsed = AssistantContentSchema.safeParse(content);
  if (!parsed.success || !parsed.data.message.usage) {
    return null;
  }

  return {
    messageId: parsed.data.message.id,
    usage: extractUsageTokens(parsed.data.message.usage),
    model: parsed.data.message.model,
    isTopLevel: parsed.data.parent_tool_use_id == null,
  };
}

/**
 * Extract per-turn usage, the cumulative cost, and the context window from a
 * result message.
 */
function extractResultUsage(content: unknown): {
  usage: ExtractedUsage | null;
  contextWindowByModel: Record<string, number>;
  totalCostUsd?: number;
} | null {
  const parsed = ResultContentSchema.safeParse(content);
  if (!parsed.success) {
    return null;
  }

  const contextWindowByModel: Record<string, number> = {};
  for (const [model, modelStats] of Object.entries(parsed.data.modelUsage ?? {})) {
    if (modelStats.contextWindow) {
      contextWindowByModel[model] = modelStats.contextWindow;
    }
  }

  return {
    usage: parsed.data.usage ? extractUsageTokens(parsed.data.usage) : null,
    contextWindowByModel,
    totalCostUsd: parsed.data.total_cost_usd,
  };
}

/**
 * Extract model name from system init message
 */
function extractModelFromInit(content: unknown): string | undefined {
  const parsed = SystemInitSchema.safeParse(content);
  if (parsed.success) {
    return parsed.data.model;
  }
  return undefined;
}

/**
 * Estimate token usage, session cost, and context window occupancy from a list
 * of messages. Messages must be in chronological order (oldest first).
 *
 * See the module docstring for the SDK semantics this relies on.
 */
export function estimateTokenUsage(messages: Message[]): TokenUsageStats {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let detectedModel: string | undefined;
  // Latest known context window per model, from result modelUsage. A result can
  // report several models (the main agent plus utility/subagent models), so the
  // window is resolved against the main model after model detection.
  const contextWindowByModel: Record<string, number> = {};

  // First pass: look for model info in system init
  for (const msg of messages) {
    if (msg.type === 'system') {
      const model = extractModelFromInit(msg.content);
      if (model) {
        detectedModel = model;
        break;
      }
    }
  }

  // Sum per-turn usage across result messages, and aggregate the cumulative
  // total_cost_usd by process segment: within one query process the value is
  // monotonically non-decreasing, so a drop marks a re-established query whose
  // counter reset. The session total is the sum of each segment's final value.
  const resultMessages = messages.filter((m) => m.type === 'result');
  let closedSegmentsCost = 0;
  let currentSegmentCost = 0;
  for (const resultMsg of resultMessages) {
    const extracted = extractResultUsage(resultMsg.content);
    if (!extracted) {
      continue;
    }
    if (extracted.usage) {
      totalInputTokens += extracted.usage.inputTokens;
      totalOutputTokens += extracted.usage.outputTokens;
      totalCacheReadTokens += extracted.usage.cacheReadTokens;
      totalCacheCreationTokens += extracted.usage.cacheCreationTokens;
    }
    Object.assign(contextWindowByModel, extracted.contextWindowByModel);
    if (extracted.totalCostUsd !== undefined) {
      if (extracted.totalCostUsd < currentSegmentCost) {
        closedSegmentsCost += currentSegmentCost;
      }
      currentSegmentCost = extracted.totalCostUsd;
    }
  }
  const totalCostUsd = closedSegmentsCost + currentSegmentCost;

  // Find the most recent top-level (main-agent) assistant message to determine
  // current context occupancy. Subagent messages (parent_tool_use_id set) run
  // in their own context and would misreport the main conversation's size.
  let lastAssistantContextTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type !== 'assistant') {
      continue;
    }
    const extracted = extractAssistantUsage(msg.content);
    if (!extracted || !extracted.isTopLevel) {
      continue;
    }
    // The prompt of the latest API call is input + cache read + cache creation
    // (newly cached tokens are part of the prompt too); output tokens become
    // input in the next call. Together they are the current occupancy.
    const { usage } = extracted;
    lastAssistantContextTokens =
      usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens + usage.outputTokens;
    if (extracted.model && !detectedModel) {
      detectedModel = extracted.model;
    }
    break;
  }

  // If we have no result messages yet (mid-first-turn), sum assistant messages
  // for total consumed tokens. Multiple assistant messages in the same step
  // share the same message id and identical usage, so deduplicate by id.
  if (resultMessages.length === 0) {
    const processedMessageIds = new Set<string>();
    for (const msg of messages) {
      if (msg.type !== 'assistant') {
        continue;
      }
      const extracted = extractAssistantUsage(msg.content);
      if (!extracted) {
        continue;
      }
      if (extracted.messageId) {
        if (processedMessageIds.has(extracted.messageId)) {
          continue;
        }
        processedMessageIds.add(extracted.messageId);
      }
      totalInputTokens += extracted.usage.inputTokens;
      totalOutputTokens += extracted.usage.outputTokens;
      totalCacheReadTokens += extracted.usage.cacheReadTokens;
      totalCacheCreationTokens += extracted.usage.cacheCreationTokens;
      if (extracted.model && !detectedModel) {
        detectedModel = extracted.model;
      }
    }
  }

  // Calculate total tokens consumed (for cost/display)
  const totalTokens = totalInputTokens + totalOutputTokens;

  // Resolve the context window: the main model's reported window, falling back
  // to the largest reported one (the main model dwarfs the utility models), then
  // the default.
  const knownWindows = Object.values(contextWindowByModel);
  const contextWindow =
    (detectedModel ? contextWindowByModel[detectedModel] : undefined) ??
    (knownWindows.length > 0 ? Math.max(...knownWindows) : DEFAULT_CONTEXT_WINDOW);

  // Calculate percentage of context window currently used.
  // Fall back to total tokens if no assistant messages found (shouldn't happen in practice).
  const currentContextTokens =
    lastAssistantContextTokens > 0 ? lastAssistantContextTokens : totalTokens;
  const percentUsed = contextWindow > 0 ? (currentContextTokens / contextWindow) * 100 : 0;

  return {
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    totalTokens,
    contextWindow,
    percentUsed: Math.min(percentUsed, 100), // Cap at 100%
    model: detectedModel,
    totalCostUsd,
  };
}

/**
 * Format token count for display (e.g., "150K" instead of "150000")
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(0)}K`;
  }
  return tokens.toString();
}

/**
 * Format percentage for display
 */
export function formatPercentage(percent: number): string {
  if (percent < 1) {
    return '<1%';
  }
  return `${Math.round(percent)}%`;
}
