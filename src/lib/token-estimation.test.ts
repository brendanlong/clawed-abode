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

    it('should sum usage from multiple assistant messages', () => {
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

    it('should prefer result messages over assistant messages', () => {
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

      // Should use result message, not assistant
      expect(result.inputTokens).toBe(5000);
      expect(result.outputTokens).toBe(2500);
    });

    it('should extract usage from modelUsage in result messages', () => {
      const messages = [
        {
          type: 'result',
          content: {
            type: 'result',
            modelUsage: {
              'claude-sonnet-4-20250514': {
                inputTokens: 3000,
                outputTokens: 1500,
                cacheReadInputTokens: 200,
                cacheCreationInputTokens: 100,
                contextWindow: 200000,
              },
            },
          },
        },
      ];

      const result = estimateTokenUsage(messages);

      expect(result.inputTokens).toBe(3000);
      expect(result.outputTokens).toBe(1500);
      expect(result.cacheReadTokens).toBe(200);
      expect(result.cacheCreationTokens).toBe(100);
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

    it('should calculate percentage used correctly', () => {
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

      // 150k / 200k = 75%
      expect(result.percentUsed).toBe(75);
    });

    it('should cap percentage at 100%', () => {
      const messages = [
        {
          type: 'result',
          content: {
            type: 'result',
            usage: {
              input_tokens: 250_000,
              output_tokens: 50_000,
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
  });
});
