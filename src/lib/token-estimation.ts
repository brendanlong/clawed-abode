/**
 * Token usage estimation utilities
 *
 * Estimates context window usage from Claude Code messages.
 *
 * Key insight: The "context usage %" should reflect how full the context window
 * currently is, NOT the total tokens consumed across all API calls. We use the
 * most recent assistant message's input_tokens + cache_read_input_tokens (the full
 * prompt size) plus output_tokens (which will become input in the next call).
 *
 * Total consumed tokens (summed from result messages) are tracked separately
 * for cost display purposes.
 */

import { z } from 'zod';

// Default context window size (200k tokens for Claude models)
// Claude Code uses context management, so the effective limit may vary
const DEFAULT_CONTEXT_WINDOW = 200_000;

// Model-specific context windows (used when we can detect the model from system init)
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-5-20251101': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-sonnet-20240620': 200_000,
  'claude-3-opus-20240229': 200_000,
  'claude-3-sonnet-20240229': 200_000,
  'claude-3-haiku-20240307': 200_000,
};

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
}

/**
 * Zod schema for message usage in assistant messages
 */
const MessageUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
});

/**
 * Zod schema for result usage in result messages
 */
const ResultUsageSchema = z.object({
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
  message: z.object({
    usage: MessageUsageSchema.optional(),
    model: z.string().optional(),
  }),
});

/**
 * Schema for result message content
 */
const ResultContentSchema = z.object({
  type: z.literal('result'),
  usage: ResultUsageSchema.optional(),
  modelUsage: z
    .record(
      z.string(),
      z.object({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        cacheReadInputTokens: z.number().optional(),
        cacheCreationInputTokens: z.number().optional(),
        contextWindow: z.number().optional(),
      })
    )
    .optional(),
});

/**
 * Message structure expected by the estimation function.
 * Messages must be provided in chronological order (oldest first).
 */
interface Message {
  type: string;
  content: unknown;
}

/**
 * Extract usage from an assistant message
 */
function extractAssistantUsage(content: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model?: string;
} | null {
  const parsed = AssistantContentSchema.safeParse(content);
  if (!parsed.success || !parsed.data.message.usage) {
    return null;
  }

  const usage = parsed.data.message.usage;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    model: parsed.data.message.model,
  };
}

/**
 * Extract usage from a result message
 */
function extractResultUsage(content: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow?: number;
} | null {
  const parsed = ResultContentSchema.safeParse(content);
  if (!parsed.success) {
    return null;
  }

  // Try to get usage from top-level usage field
  const usage = parsed.data.usage;
  if (usage) {
    return {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    };
  }

  // Try to get usage from modelUsage (aggregated per-model stats)
  const modelUsage = parsed.data.modelUsage;
  if (modelUsage) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let contextWindow: number | undefined;

    for (const modelStats of Object.values(modelUsage)) {
      inputTokens += modelStats.inputTokens ?? 0;
      outputTokens += modelStats.outputTokens ?? 0;
      cacheReadTokens += modelStats.cacheReadInputTokens ?? 0;
      cacheCreationTokens += modelStats.cacheCreationInputTokens ?? 0;
      if (modelStats.contextWindow) {
        contextWindow = modelStats.contextWindow;
      }
    }

    return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, contextWindow };
  }

  return null;
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
 * Get context window size for a model
 */
function getContextWindow(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;

  // Try exact match first
  if (MODEL_CONTEXT_WINDOWS[model]) {
    return MODEL_CONTEXT_WINDOWS[model];
  }

  // Try partial match (for versioned model names)
  for (const [pattern, window] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.includes(pattern.split('-').slice(0, 3).join('-'))) {
      return window;
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Estimate token usage and context window occupancy from a list of messages.
 *
 * Messages should be in chronological order (oldest first).
 *
 * Context percentage is based on the most recent assistant message's input_tokens,
 * which represents the actual size of the prompt/context sent in the latest API call.
 * This is the best proxy for how full the context window currently is.
 *
 * Total consumed tokens (inputTokens, outputTokens in the result) are summed from
 * result messages for cost tracking purposes.
 */
export function estimateTokenUsage(messages: Message[]): TokenUsageStats {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let detectedModel: string | undefined;
  let detectedContextWindow: number | undefined;

  // Track the most recent assistant message's input tokens for context % calculation.
  // input_tokens represents the full prompt size for that API call, which is our
  // best proxy for current context window occupancy.
  let lastAssistantInputTokens = 0;

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

  // Sum up total consumed tokens from result messages (for cost tracking)
  const resultMessages = messages.filter((m) => m.type === 'result');
  for (const resultMsg of resultMessages) {
    const usage = extractResultUsage(resultMsg.content);
    if (usage) {
      totalInputTokens += usage.inputTokens;
      totalOutputTokens += usage.outputTokens;
      totalCacheReadTokens += usage.cacheReadTokens;
      totalCacheCreationTokens += usage.cacheCreationTokens;
      if (usage.contextWindow) {
        detectedContextWindow = usage.contextWindow;
      }
    }
  }

  // Find the most recent assistant message to determine current context occupancy.
  // We iterate in reverse to find it efficiently.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'assistant') {
      const usage = extractAssistantUsage(msg.content);
      if (usage) {
        // input_tokens from the Anthropic API represents non-cached input tokens.
        // cache_read_input_tokens are tokens read from cache.
        // output_tokens will become part of the input in the next API call.
        // Together they represent the current context window occupancy.
        lastAssistantInputTokens = usage.inputTokens + usage.cacheReadTokens + usage.outputTokens;
        if (usage.model && !detectedModel) {
          detectedModel = usage.model;
        }
        break;
      }
    }
  }

  // If we have no result messages yet, sum assistant messages for total consumed tokens
  if (resultMessages.length === 0) {
    for (const msg of messages) {
      if (msg.type === 'assistant') {
        const usage = extractAssistantUsage(msg.content);
        if (usage) {
          totalInputTokens += usage.inputTokens;
          totalOutputTokens += usage.outputTokens;
          totalCacheReadTokens += usage.cacheReadTokens;
          totalCacheCreationTokens += usage.cacheCreationTokens;
          if (usage.model && !detectedModel) {
            detectedModel = usage.model;
          }
        }
      }
    }
  }

  // Calculate total tokens consumed (for cost/display)
  const totalTokens = totalInputTokens + totalOutputTokens;

  // Determine context window capacity
  const contextWindow = detectedContextWindow ?? getContextWindow(detectedModel);

  // Calculate percentage of context window currently used.
  // Use the most recent assistant message's prompt size as the indicator.
  // Fall back to total tokens if no assistant messages found (shouldn't happen in practice).
  const currentContextTokens =
    lastAssistantInputTokens > 0 ? lastAssistantInputTokens : totalTokens;
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
