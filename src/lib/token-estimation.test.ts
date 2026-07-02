import { describe, it, expect } from 'vitest';
import { estimateTokenUsage, formatTokenCount, formatPercentage } from './token-estimation';

describe('token-estimation', () => {
  describe('formatTokenCount', () => {
    it('should format millions with M suffix', () => {
      expect(formatTokenCount(1_000_000)).toBe('1.0M');
      expect(formatTokenCount(1_500_000)).toBe('1.5M');
      expect(formatTokenCount(10_000_000)).toBe('10.0M');
    });

    it('should format thousands with K suffix', () => {
      expect(formatTokenCount(1_000)).toBe('1K');
      expect(formatTokenCount(1_500)).toBe('2K'); // Rounds to nearest integer
      expect(formatTokenCount(50_000)).toBe('50K');
      expect(formatTokenCount(999_999)).toBe('1000K');
    });

    it('should show raw number below 1000', () => {
      expect(formatTokenCount(0)).toBe('0');
      expect(formatTokenCount(1)).toBe('1');
      expect(formatTokenCount(500)).toBe('500');
      expect(formatTokenCount(999)).toBe('999');
    });
  });

  describe('formatPercentage', () => {
    it('should show <1% for small percentages', () => {
      expect(formatPercentage(0)).toBe('<1%');
      expect(formatPercentage(0.5)).toBe('<1%');
      expect(formatPercentage(0.99)).toBe('<1%');
    });

    it('should round to nearest integer', () => {
      expect(formatPercentage(1)).toBe('1%');
      expect(formatPercentage(1.4)).toBe('1%');
      expect(formatPercentage(1.5)).toBe('2%');
      expect(formatPercentage(50)).toBe('50%');
      expect(formatPercentage(99.9)).toBe('100%');
    });
  });

  describe('estimateTokenUsage', () => {
    it('should return zero stats for empty messages', () => {
      const result = estimateTokenUsage([]);

      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.totalTokens).toBe(0);
      expect(result.contextWindow).toBe(200_000); // Default
      expect(result.percentUsed).toBe(0);
      expect(result.totalCostUsd).toBe(0);
    });

    it('should extract usage from assistant messages when no result messages', () => {
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              usage: {
                input_tokens: 1000,
                output_tokens: 500,
                cache_read_input_tokens: 100,
                cache_creation_input_tokens: 50,
              },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
      expect(result.cacheReadTokens).toBe(100);
      expect(result.cacheCreationTokens).toBe(50);
      expect(result.totalTokens).toBe(1500);
    });

    it('should sum usage from multiple assistant messages for total tokens', () => {
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              usage: { input_tokens: 1000, output_tokens: 500 },
            },
          },
        },
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              usage: { input_tokens: 2000, output_tokens: 1000 },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.inputTokens).toBe(3000);
      expect(result.outputTokens).toBe(1500);
      expect(result.totalTokens).toBe(4500);
    });

    it('should use last assistant message input_tokens for context percentage', () => {
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              usage: { input_tokens: 5000, output_tokens: 500 },
            },
          },
        },
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              // Context grows: the second API call has a larger prompt
              usage: { input_tokens: 10000, output_tokens: 1000 },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      // Total tokens summed from both messages (no result messages present)
      expect(result.inputTokens).toBe(15000);
      expect(result.outputTokens).toBe(1500);
      expect(result.totalTokens).toBe(16500);

      // Context % based on the LAST assistant message's input + output (10000 + 1000 = 11000)
      // 11000 / 200000 = 5.5%
      expect(result.percentUsed).toBeCloseTo(5.5, 0);
    });

    it('should include cache_read_input_tokens in context percentage', () => {
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              usage: {
                input_tokens: 5000,
                output_tokens: 500,
                cache_read_input_tokens: 45000,
              },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      // Context occupancy = input_tokens + cache_read + output = 5000 + 45000 + 500 = 50500
      // 50500 / 200000 = 25.25%
      expect(result.percentUsed).toBeCloseTo(25.25, 1);
    });

    it('should prefer result messages for total token counts over assistant messages', () => {
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              usage: { input_tokens: 1000, output_tokens: 500 },
            },
          },
        },
        {
          type: 'result',
          content: {
            type: 'result',
            usage: {
              input_tokens: 5000,
              output_tokens: 2500,
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      // Total tokens come from result message
      expect(result.inputTokens).toBe(5000);
      expect(result.outputTokens).toBe(2500);
    });

    it('should use assistant message for context % even when result messages exist', () => {
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              usage: {
                input_tokens: 50000,
                output_tokens: 500,
                cache_read_input_tokens: 50000,
              },
            },
          },
        },
        {
          type: 'result',
          content: {
            type: 'result',
            // Result usage sums all API calls in the query, which is NOT current context size
            usage: {
              input_tokens: 80000,
              output_tokens: 10000,
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      // Total tokens from result message (for cost)
      expect(result.inputTokens).toBe(80000);
      expect(result.outputTokens).toBe(10000);
      expect(result.totalTokens).toBe(90000);

      // Context % from last assistant message: input + cache_read + output = 50000 + 50000 + 500 = 100500
      // 100500 / 200000 = 50.25%
      expect(result.percentUsed).toBeCloseTo(50.25, 1);
    });

    it('should not sum cumulative modelUsage token counts into totals', () => {
      // modelUsage token counts are cumulative per query process — summing them
      // across results would double count. Only per-turn `usage` is summed.
      const messages = [
        {
          type: 'result',
          content: {
            type: 'result',
            usage: { input_tokens: 100, output_tokens: 50 },
            modelUsage: {
              'claude-sonnet-4-20250514': { inputTokens: 100, outputTokens: 50 },
            },
          },
        },
        {
          type: 'result',
          content: {
            type: 'result',
            usage: { input_tokens: 200, output_tokens: 100 },
            modelUsage: {
              // Cumulative: includes the first turn's tokens
              'claude-sonnet-4-20250514': { inputTokens: 300, outputTokens: 150 },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.inputTokens).toBe(300);
      expect(result.outputTokens).toBe(150);
    });

    it('should detect model from system init message', () => {
      const messages = [
        {
          type: 'system',
          content: {
            type: 'system',
            subtype: 'init',
            model: 'claude-opus-4-5-20251101',
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.model).toBe('claude-opus-4-5-20251101');
      expect(result.contextWindow).toBe(200_000);
    });

    it('should detect model from assistant message', () => {
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              model: 'claude-3-5-sonnet-20241022',
              usage: { input_tokens: 100, output_tokens: 50 },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.model).toBe('claude-3-5-sonnet-20241022');
    });

    it('should calculate percentage based on last assistant message', () => {
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              usage: {
                input_tokens: 100_000,
                output_tokens: 5_000,
              },
            },
          },
        },
        {
          type: 'result',
          content: {
            type: 'result',
            usage: {
              input_tokens: 100_000,
              output_tokens: 50_000,
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      // Context % based on last assistant's input + output: (100k + 5k) / 200k = 52.5%
      expect(result.percentUsed).toBeCloseTo(52.5, 0);
    });

    it('should cap percentage at 100%', () => {
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              usage: {
                input_tokens: 250_000,
                output_tokens: 1_000,
              },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.percentUsed).toBe(100);
    });

    it('should handle messages with missing usage data', () => {
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {}, // No usage
          },
        },
        {
          type: 'user',
          content: {
            type: 'user',
            message: 'Hello',
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
    });

    it('should use context window from result message modelUsage', () => {
      const messages = [
        {
          type: 'result',
          content: {
            type: 'result',
            modelUsage: {
              'claude-sonnet-4-20250514': {
                inputTokens: 1000,
                outputTokens: 500,
                contextWindow: 150000, // Custom context window
              },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.contextWindow).toBe(150000);
    });

    it('should use context window from modelUsage even when top-level usage is present', () => {
      // Real result messages always carry both; the context window (e.g. 1M for
      // [1m] models) must not be ignored just because usage was parsed.
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              usage: {
                input_tokens: 250_000,
                output_tokens: 1_000,
                cache_read_input_tokens: 50_000,
              },
            },
          },
        },
        {
          type: 'result',
          content: {
            type: 'result',
            usage: { input_tokens: 250_000, output_tokens: 1_000 },
            modelUsage: {
              'claude-opus-4-8[1m]': {
                inputTokens: 250_000,
                outputTokens: 1_000,
                contextWindow: 1_000_000,
              },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.contextWindow).toBe(1_000_000);
      // (250k + 1k + 50k) / 1M ≈ 30.1%, not capped at 100%
      expect(result.percentUsed).toBeCloseTo(30.1, 1);
    });

    it('should resolve the context window by the main model when modelUsage has several models', () => {
      const messages = [
        {
          type: 'system',
          content: { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' },
        },
        {
          type: 'result',
          content: {
            type: 'result',
            usage: { input_tokens: 1000, output_tokens: 500 },
            modelUsage: {
              // The main model's window must win even when another entry
              // (e.g. an advisor or subagent model) reports a larger one.
              'claude-opus-4-8[1m]': { contextWindow: 1_000_000 },
              'claude-sonnet-4-6': { contextWindow: 200_000 },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.contextWindow).toBe(200_000);
    });

    it('should include cache_creation_input_tokens in context percentage', () => {
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              usage: {
                input_tokens: 1000,
                output_tokens: 500,
                cache_read_input_tokens: 40_000,
                cache_creation_input_tokens: 8_500,
              },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      // (1000 + 40000 + 8500 + 500) / 200000 = 25%
      expect(result.percentUsed).toBeCloseTo(25, 1);
    });

    it('should skip subagent assistant messages for context percentage', () => {
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            parent_tool_use_id: null,
            message: {
              usage: { input_tokens: 100_000, output_tokens: 1_000 },
            },
          },
        },
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            // A subagent message runs in its own, smaller context
            parent_tool_use_id: 'toolu_abc123',
            message: {
              usage: { input_tokens: 5_000, output_tokens: 200 },
            },
          },
        },
        {
          type: 'result',
          content: {
            type: 'result',
            usage: { input_tokens: 105_000, output_tokens: 1_200 },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      // Context % from the last TOP-LEVEL assistant message: (100k + 1k) / 200k
      expect(result.percentUsed).toBeCloseTo(50.5, 1);
    });

    it('should fall back to total tokens for % when no assistant messages', () => {
      // This shouldn't happen in practice but tests the fallback
      const messages = [
        {
          type: 'result',
          content: {
            type: 'result',
            usage: {
              input_tokens: 100_000,
              output_tokens: 50_000,
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      // Falls back to total tokens: (100k + 50k) / 200k = 75%
      expect(result.percentUsed).toBe(75);
    });

    it('should extract total_cost_usd from result messages', () => {
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              usage: { input_tokens: 1000, output_tokens: 500 },
            },
          },
        },
        {
          type: 'result',
          content: {
            type: 'result',
            total_cost_usd: 0.0523,
            usage: {
              input_tokens: 5000,
              output_tokens: 2500,
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.totalCostUsd).toBeCloseTo(0.0523, 4);
    });

    it('should treat total_cost_usd as cumulative within one query process', () => {
      // total_cost_usd is cumulative since the query process started, so the
      // session total is the LAST value, not the sum of all results.
      const messages = [
        {
          type: 'result',
          content: {
            type: 'result',
            total_cost_usd: 0.05,
            usage: { input_tokens: 1000, output_tokens: 500 },
          },
        },
        {
          type: 'result',
          content: {
            type: 'result',
            total_cost_usd: 0.15,
            usage: { input_tokens: 2000, output_tokens: 1000 },
          },
        },
        {
          type: 'result',
          content: {
            type: 'result',
            total_cost_usd: 0.35,
            usage: { input_tokens: 1500, output_tokens: 800 },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.totalCostUsd).toBeCloseTo(0.35, 4);
      // Per-turn usage IS summed
      expect(result.inputTokens).toBe(4500);
      expect(result.outputTokens).toBe(2300);
    });

    it('should detect a query-process reset (cost drop) and sum segment totals', () => {
      // A stop/start or server restart re-establishes the query and resets the
      // SDK's cumulative counter to zero. The session total is the sum of each
      // process segment's final cumulative value: 0.5 + 0.2 = 0.7.
      const messages = [
        { type: 'result', content: { type: 'result', total_cost_usd: 0.3, usage: {} } },
        { type: 'result', content: { type: 'result', total_cost_usd: 0.5, usage: {} } },
        // Query re-established: counter reset
        { type: 'result', content: { type: 'result', total_cost_usd: 0.1, usage: {} } },
        { type: 'result', content: { type: 'result', total_cost_usd: 0.2, usage: {} } },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.totalCostUsd).toBeCloseTo(0.7, 4);
    });

    it('should handle multiple query-process resets', () => {
      const messages = [
        { type: 'result', content: { type: 'result', total_cost_usd: 1.0, usage: {} } },
        // Reset 1
        { type: 'result', content: { type: 'result', total_cost_usd: 0.4, usage: {} } },
        { type: 'result', content: { type: 'result', total_cost_usd: 0.9, usage: {} } },
        // Reset 2
        { type: 'result', content: { type: 'result', total_cost_usd: 0.25, usage: {} } },
      ];

      const result = estimateTokenUsage(messages);

      // 1.0 + 0.9 + 0.25
      expect(result.totalCostUsd).toBeCloseTo(2.15, 4);
    });

    it('should not treat an equal cumulative cost as a reset', () => {
      const messages = [
        { type: 'result', content: { type: 'result', total_cost_usd: 0.5, usage: {} } },
        { type: 'result', content: { type: 'result', total_cost_usd: 0.5, usage: {} } },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.totalCostUsd).toBeCloseTo(0.5, 4);
    });

    it('should deduplicate assistant messages with the same id (parallel tool uses)', () => {
      // Per Anthropic docs: when Claude sends multiple messages in the same step
      // (text + parallel tool uses), they share the same message ID and usage.
      // We should only count usage once per unique ID.
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              id: 'msg_123',
              usage: { input_tokens: 1000, output_tokens: 500 },
            },
          },
        },
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              id: 'msg_123', // Same ID - parallel tool use
              usage: { input_tokens: 1000, output_tokens: 500 },
            },
          },
        },
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              id: 'msg_123', // Same ID - another parallel tool use
              usage: { input_tokens: 1000, output_tokens: 500 },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      // Should only count once, not three times
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
      expect(result.totalTokens).toBe(1500);
    });

    it('should count assistant messages with different ids separately', () => {
      // Different steps have different message IDs
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              id: 'msg_1',
              usage: { input_tokens: 1000, output_tokens: 500 },
            },
          },
        },
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              id: 'msg_2', // Different step
              usage: { input_tokens: 2000, output_tokens: 1000 },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.inputTokens).toBe(3000);
      expect(result.outputTokens).toBe(1500);
      expect(result.totalTokens).toBe(4500);
    });

    it('should still sum assistant messages without ids (backwards compatibility)', () => {
      // Older messages might not have an id field
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              usage: { input_tokens: 1000, output_tokens: 500 },
            },
          },
        },
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              usage: { input_tokens: 2000, output_tokens: 1000 },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.inputTokens).toBe(3000);
      expect(result.outputTokens).toBe(1500);
    });

    it('should extract total_cost_usd from result with modelUsage but no usage', () => {
      const messages = [
        {
          type: 'result',
          content: {
            type: 'result',
            total_cost_usd: 0.0842,
            modelUsage: {
              'claude-sonnet-4-20250514': {
                inputTokens: 3000,
                outputTokens: 1500,
                costUSD: 0.0842,
              },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.totalCostUsd).toBeCloseTo(0.0842, 4);
    });

    it('should return totalCostUsd of 0 when no result messages', () => {
      const messages = [
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            message: {
              usage: { input_tokens: 1000, output_tokens: 500 },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.totalCostUsd).toBe(0);
    });
  });
});
