import { describe, it, expect } from 'vitest';
import {
  affectsTokenUsage,
  buildTokenUsageStats,
  EMPTY_SESSION_USAGE_TOTALS,
  extractResultUsage,
  formatPercentage,
  formatTokenCount,
  type SessionUsageTotals,
} from './token-estimation';

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
      expect(formatTokenCount(999_499)).toBe('999K');
      expect(formatTokenCount(999_999)).toBe('1.0M');
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
      expect(formatPercentage(99.9)).toBe('99%');
      expect(formatPercentage(100)).toBe('100%');
      expect(formatPercentage(120.4)).toBe('120%');
    });
  });

  describe('buildTokenUsageStats', () => {
    const totals = (overrides: Partial<SessionUsageTotals> = {}): SessionUsageTotals => ({
      ...EMPTY_SESSION_USAGE_TOTALS,
      ...overrides,
    });
    const assistant = (
      usage: Record<string, number>,
      extra: { model?: string; parent_tool_use_id?: string | null } = {}
    ) => ({
      type: 'assistant',
      parent_tool_use_id: extra.parent_tool_use_id ?? null,
      message: { usage, ...(extra.model && { model: extra.model }) },
    });

    it('should return zero stats for an empty session', () => {
      const result = buildTokenUsageStats(totals(), undefined);

      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.totalTokens).toBe(0);
      expect(result.contextWindow).toBe(200_000);
      expect(result.percentUsed).toBe(0);
      expect(result.totalCostUsd).toBe(0);
    });

    it('should use the last assistant usage as totals before the first result', () => {
      const result = buildTokenUsageStats(
        totals(),
        assistant({
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        })
      );

      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
      expect(result.cacheReadTokens).toBe(100);
      expect(result.cacheCreationTokens).toBe(50);
      expect(result.totalTokens).toBe(1500);
    });

    it('should use the result totals once a result exists', () => {
      const result = buildTokenUsageStats(
        totals({ resultCount: 1, inputTokens: 80_000, outputTokens: 10_000 }),
        assistant({ input_tokens: 50_000, output_tokens: 500, cache_read_input_tokens: 50_000 })
      );

      expect(result.inputTokens).toBe(80_000);
      expect(result.outputTokens).toBe(10_000);
      expect(result.totalTokens).toBe(90_000);
      // Context % from the assistant message: (50000 + 50000 + 500) / 200000
      expect(result.percentUsed).toBeCloseTo(50.25, 1);
    });

    it('should count input, cache read, cache creation, and output toward context %', () => {
      const result = buildTokenUsageStats(
        totals(),
        assistant({
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 40_000,
          cache_creation_input_tokens: 8_500,
        })
      );

      // (1000 + 40000 + 8500 + 500) / 200000 = 25%
      expect(result.percentUsed).toBeCloseTo(25, 1);
    });

    it('should ignore a subagent assistant message', () => {
      const result = buildTokenUsageStats(
        totals({ resultCount: 1, inputTokens: 100_000, outputTokens: 50_000 }),
        assistant({ input_tokens: 5_000, output_tokens: 200 }, { parent_tool_use_id: 'toolu_1' })
      );

      // Falls back to total tokens: (100k + 50k) / 200k
      expect(result.percentUsed).toBe(75);
    });

    it('should fall back to total tokens for % when there is no assistant message', () => {
      const result = buildTokenUsageStats(
        totals({ resultCount: 1, inputTokens: 100_000, outputTokens: 50_000 }),
        undefined
      );

      expect(result.percentUsed).toBe(75);
    });

    it('should cap percentage at 100%', () => {
      const result = buildTokenUsageStats(
        totals(),
        assistant({ input_tokens: 250_000, output_tokens: 1_000 })
      );

      expect(result.percentUsed).toBe(100);
    });

    it('should use the init model, falling back to the assistant model', () => {
      expect(
        buildTokenUsageStats(
          totals({ model: 'claude-opus-4-5' }),
          assistant({ input_tokens: 1 }, { model: 'claude-sonnet-4-6' })
        ).model
      ).toBe('claude-opus-4-5');
      expect(
        buildTokenUsageStats(
          totals(),
          assistant({ input_tokens: 1 }, { model: 'claude-sonnet-4-6' })
        ).model
      ).toBe('claude-sonnet-4-6');
    });

    it('should use the reported context window', () => {
      const result = buildTokenUsageStats(
        totals({ resultCount: 1, contextWindowByModel: { 'claude-opus-4-8[1m]': 1_000_000 } }),
        assistant({ input_tokens: 250_000, output_tokens: 1_000, cache_read_input_tokens: 50_000 })
      );

      expect(result.contextWindow).toBe(1_000_000);
      expect(result.percentUsed).toBeCloseTo(30.1, 1);
    });

    it("should prefer the main model's context window over a larger one", () => {
      const result = buildTokenUsageStats(
        totals({
          model: 'claude-sonnet-4-6',
          contextWindowByModel: { 'claude-opus-4-8[1m]': 1_000_000, 'claude-sonnet-4-6': 200_000 },
        }),
        undefined
      );

      expect(result.contextWindow).toBe(200_000);
    });

    it('should fall back to the largest context window when the main model has none', () => {
      const result = buildTokenUsageStats(
        totals({ contextWindowByModel: { a: 150_000, b: 1_000_000 } }),
        undefined
      );

      expect(result.contextWindow).toBe(1_000_000);
    });

    it('should add the closed and current cost segments', () => {
      const result = buildTokenUsageStats(
        totals({ resultCount: 4, closedSegmentsCostUsd: 0.5, currentSegmentCostUsd: 0.2 }),
        undefined
      );

      expect(result.totalCostUsd).toBeCloseTo(0.7, 4);
    });
  });

  describe('extractResultUsage', () => {
    it('should extract per-turn usage, cost, and context windows but not cumulative modelUsage tokens', () => {
      expect(
        extractResultUsage({
          type: 'result',
          total_cost_usd: 0.08,
          usage: { input_tokens: 200, output_tokens: 100 },
          modelUsage: {
            'claude-sonnet-4-6': { inputTokens: 300, outputTokens: 150, contextWindow: 200_000 },
            'claude-haiku-4-5': { inputTokens: 10 },
          },
        })
      ).toEqual({
        usage: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 },
        contextWindowByModel: { 'claude-sonnet-4-6': 200_000 },
        totalCostUsd: 0.08,
      });
    });

    it('should return null cost and usage when absent', () => {
      expect(extractResultUsage({ type: 'result' })).toEqual({
        usage: null,
        contextWindowByModel: {},
        totalCostUsd: null,
      });
    });

    it('should reject non-result content', () => {
      expect(extractResultUsage({ type: 'assistant' })).toBeNull();
    });
  });

  describe('affectsTokenUsage', () => {
    it('should be true for results, system/init, and top-level assistant messages', () => {
      expect(affectsTokenUsage('result', { type: 'result' })).toBe(true);
      expect(
        affectsTokenUsage('system', { type: 'system', subtype: 'init', model: 'claude-opus-4-5' })
      ).toBe(true);
      expect(
        affectsTokenUsage('assistant', {
          type: 'assistant',
          parent_tool_use_id: null,
          message: { usage: { input_tokens: 1 } },
        })
      ).toBe(true);
    });

    it('should be false for user, subagent, and other system messages', () => {
      expect(affectsTokenUsage('user', { type: 'user', message: 'hi' })).toBe(false);
      expect(
        affectsTokenUsage('assistant', {
          type: 'assistant',
          parent_tool_use_id: 'toolu_1',
          message: { usage: { input_tokens: 1 } },
        })
      ).toBe(false);
      expect(affectsTokenUsage('system', { type: 'system', subtype: 'error' })).toBe(false);
    });
  });
});
