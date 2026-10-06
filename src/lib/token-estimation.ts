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
 * non-decreasing within a process, so a drop means the counter reset. The fold
 * itself runs in SQL as each message is inserted (src/server/services/session-usage.ts).
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
 */
function extractAssistantUsage(content: unknown): {
  usage: ExtractedUsage;
  model?: string;
  isTopLevel: boolean;
} | null {
  const parsed = AssistantContentSchema.safeParse(content);
  if (!parsed.success || !parsed.data.message.usage) {
    return null;
  }

  return {
    usage: extractUsageTokens(parsed.data.message.usage),
    model: parsed.data.message.model,
    isTopLevel: parsed.data.parent_tool_use_id == null,
  };
}

export interface ResultUsage {
  usage: ExtractedUsage | null;
  contextWindowByModel: Record<string, number>;
  /** Cumulative for the query process, not per-turn (see the module docstring). */
  totalCostUsd: number | null;
}

/**
 * Extract per-turn usage, the cumulative cost, and the context window from a
 * result message.
 */
export function extractResultUsage(content: unknown): ResultUsage | null {
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
    totalCostUsd: parsed.data.total_cost_usd ?? null,
  };
}

export function extractModelFromInit(content: unknown): string | undefined {
  const parsed = SystemInitSchema.safeParse(content);
  return parsed.success ? parsed.data.model : undefined;
}

/**
 * Whether a persisted message can change the stats: results and system/init
 * move the running totals, a top-level assistant message moves the context %.
 */
export function affectsTokenUsage(type: string, content: unknown): boolean {
  if (type === 'result') return true;
  if (type === 'system') return extractModelFromInit(content) !== undefined;
  if (type === 'assistant') return extractAssistantUsage(content)?.isTopLevel ?? false;
  return false;
}

/** Running totals folded from a session's result and system/init messages. */
export interface SessionUsageTotals {
  resultCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Final cumulative cost of each query process that has since reset. */
  closedSegmentsCostUsd: number;
  /** Latest cumulative cost reported by the current query process. */
  currentSegmentCostUsd: number;
  /** Latest reported context window per model. */
  contextWindowByModel: Record<string, number>;
  /** From the first system/init. */
  model?: string;
}

export const EMPTY_SESSION_USAGE_TOTALS: SessionUsageTotals = {
  resultCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  closedSegmentsCostUsd: 0,
  currentSegmentCostUsd: 0,
  contextWindowByModel: {},
};

/**
 * Build the stats from a session's running totals and the content of its most
 * recent top-level (main-agent) assistant message, if any.
 *
 * See the module docstring for the SDK semantics this relies on.
 */
export function buildTokenUsageStats(
  totals: SessionUsageTotals,
  lastTopLevelAssistant: unknown
): TokenUsageStats {
  let { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = totals;
  let detectedModel = totals.model;

  // The prompt of the latest API call is input + cache read + cache creation
  // (newly cached tokens are part of the prompt too); output tokens become
  // input in the next call. Together they are the current occupancy.
  const assistant = extractAssistantUsage(lastTopLevelAssistant);
  const lastAssistantUsage = assistant?.isTopLevel ? assistant.usage : undefined;
  const lastAssistantContextTokens = lastAssistantUsage
    ? lastAssistantUsage.inputTokens +
      lastAssistantUsage.cacheReadTokens +
      lastAssistantUsage.cacheCreationTokens +
      lastAssistantUsage.outputTokens
    : 0;
  if (lastAssistantUsage && !detectedModel) {
    detectedModel = assistant?.model;
  }

  // With no result messages yet (mid-first-turn), the latest assistant call's
  // usage is the best available total.
  if (totals.resultCount === 0 && lastAssistantUsage) {
    ({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = lastAssistantUsage);
  }

  const totalTokens = inputTokens + outputTokens;

  // Resolve the context window: the main model's reported window, falling back
  // to the largest reported one (the main model dwarfs the utility models), then
  // the default.
  const knownWindows = Object.values(totals.contextWindowByModel);
  const contextWindow =
    (detectedModel ? totals.contextWindowByModel[detectedModel] : undefined) ??
    (knownWindows.length > 0 ? Math.max(...knownWindows) : DEFAULT_CONTEXT_WINDOW);

  // Fall back to total tokens if no assistant messages found (shouldn't happen in practice).
  const currentContextTokens =
    lastAssistantContextTokens > 0 ? lastAssistantContextTokens : totalTokens;
  const percentUsed = contextWindow > 0 ? (currentContextTokens / contextWindow) * 100 : 0;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    contextWindow,
    percentUsed: Math.min(percentUsed, 100),
    model: detectedModel,
    totalCostUsd: totals.closedSegmentsCostUsd + totals.currentSegmentCostUsd,
  };
}

/**
 * Format token count for display (e.g., "150K" instead of "150000")
 */
export function formatTokenCount(tokens: number): string {
  const thousands = Math.round(tokens / 1_000);
  if (thousands >= 1_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${thousands}K`;
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
  // Never round a not-yet-full window up to 100%
  const rounded = percent < 100 ? Math.min(Math.round(percent), 99) : Math.round(percent);
  return `${rounded}%`;
}
