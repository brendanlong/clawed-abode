import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ContentBlockSchema,
  AssistantContentSchema,
  UserContentSchema,
  SystemInitContentSchema,
  ResultContentSchema,
  classifyMessage,
  isIgnoredSystemMessage,
  parseRetryState,
  formatRetryReason,
} from './claude-messages';

describe('claude-messages', () => {
  describe('Content Block Schemas', () => {
    describe('TextBlockSchema', () => {
      it('should parse valid text block', () => {
        const result = TextBlockSchema.safeParse({ type: 'text', text: 'Hello world' });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.text).toBe('Hello world');
        }
      });

      it('should reject missing text', () => {
        const result = TextBlockSchema.safeParse({ type: 'text' });
        expect(result.success).toBe(false);
      });
    });

    describe('ToolUseBlockSchema', () => {
      it('should parse valid tool use block', () => {
        const result = ToolUseBlockSchema.safeParse({
          type: 'tool_use',
          id: 'tool-123',
          name: 'Read',
          input: { file_path: '/test/file.ts' },
        });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.name).toBe('Read');
          expect(result.data.input).toEqual({ file_path: '/test/file.ts' });
        }
      });
    });

    describe('ToolResultBlockSchema', () => {
      it('should parse tool result with content', () => {
        const result = ToolResultBlockSchema.safeParse({
          type: 'tool_result',
          tool_use_id: 'tool-123',
          content: 'File contents here',
        });
        expect(result.success).toBe(true);
      });

      it('should parse tool result with error', () => {
        const result = ToolResultBlockSchema.safeParse({
          type: 'tool_result',
          tool_use_id: 'tool-123',
          content: 'File not found',
          is_error: true,
        });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.is_error).toBe(true);
        }
      });
    });

    describe('ContentBlockSchema (discriminated union)', () => {
      it('should parse text block', () => {
        const result = ContentBlockSchema.safeParse({ type: 'text', text: 'hello' });
        expect(result.success).toBe(true);
      });

      it('should parse tool_use block', () => {
        const result = ContentBlockSchema.safeParse({
          type: 'tool_use',
          id: 'id',
          name: 'Bash',
          input: {},
        });
        expect(result.success).toBe(true);
      });

      it('should parse thinking block', () => {
        const result = ContentBlockSchema.safeParse({
          type: 'thinking',
          thinking: 'let me reason',
          signature: 'sig',
        });
        expect(result.success).toBe(true);
      });

      it('should parse thinking block without signature (mid-stream)', () => {
        const result = ContentBlockSchema.safeParse({ type: 'thinking', thinking: 'partial' });
        expect(result.success).toBe(true);
      });

      it('should parse redacted_thinking block', () => {
        const result = ContentBlockSchema.safeParse({ type: 'redacted_thinking', data: 'abc' });
        expect(result.success).toBe(true);
      });

      it('should parse server_tool_use block (advisor)', () => {
        const result = ContentBlockSchema.safeParse({
          type: 'server_tool_use',
          id: 'srvtoolu_014mCNVrW6NLM6TiYm3bX4Ue',
          name: 'advisor',
          input: {},
        });
        expect(result.success).toBe(true);
      });

      it('should parse advisor_tool_result block with encrypted content', () => {
        const result = ContentBlockSchema.safeParse({
          type: 'advisor_tool_result',
          tool_use_id: 'srvtoolu_014mCNVrW6NLM6TiYm3bX4Ue',
          content: { type: 'advisor_redacted_result', encrypted_content: 'Eu8NCioI...' },
        });
        expect(result.success).toBe(true);
      });

      it('should reject unknown block type', () => {
        const result = ContentBlockSchema.safeParse({ type: 'unknown', data: 'test' });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Message Content Schemas', () => {
    describe('AssistantContentSchema', () => {
      it('should parse valid assistant content', () => {
        const content = {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello!' }],
          },
          session_id: 'session-123',
          uuid: 'uuid-456',
        };
        const result = AssistantContentSchema.safeParse(content);
        expect(result.success).toBe(true);
      });

      it('should parse assistant with tool use and usage', () => {
        const content = {
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-3-5-sonnet-20241022',
            content: [
              { type: 'text', text: 'Let me read that file.' },
              { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/test.ts' } },
            ],
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
            },
          },
          session_id: 'session-123',
          uuid: 'uuid-456',
        };
        const result = AssistantContentSchema.safeParse(content);
        expect(result.success).toBe(true);
      });
    });

    describe('UserContentSchema', () => {
      it('should parse user message with tool results', () => {
        const content = {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' }],
          },
          session_id: 'session-123',
          uuid: 'uuid-456',
        };
        const result = UserContentSchema.safeParse(content);
        expect(result.success).toBe(true);
      });
    });

    describe('SystemInitContentSchema', () => {
      it('should parse system init message', () => {
        const content = {
          type: 'system',
          subtype: 'init',
          cwd: '/workspace',
          session_id: 'session-123',
          model: 'claude-opus-4-5-20251101',
          tools: ['Read', 'Write', 'Bash'],
        };
        const result = SystemInitContentSchema.safeParse(content);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.model).toBe('claude-opus-4-5-20251101');
          expect(result.data.tools).toContain('Read');
        }
      });
    });

    describe('ResultContentSchema', () => {
      it('should parse success result', () => {
        const content = {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-123',
          duration_ms: 5000,
          num_turns: 3,
          total_cost_usd: 0.05,
        };
        const result = ResultContentSchema.safeParse(content);
        expect(result.success).toBe(true);
      });

      it('should parse result with usage and modelUsage', () => {
        const content = {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-123',
          usage: {
            input_tokens: 5000,
            output_tokens: 2000,
          },
          modelUsage: {
            'claude-3-5-sonnet': {
              inputTokens: 5000,
              outputTokens: 2000,
              costUSD: 0.05,
            },
          },
        };
        const result = ResultContentSchema.safeParse(content);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('classifyMessage', () => {
    // Synthetic messages; classifyMessage only inspects type/subtype.
    const msg = (m: Record<string, unknown>) => classifyMessage(m as unknown as SDKMessage);

    it('persists user/assistant/result under their own db type', () => {
      expect(msg({ type: 'assistant' })).toEqual({ kind: 'persist', dbType: 'assistant' });
      expect(msg({ type: 'user' })).toEqual({ kind: 'persist', dbType: 'user' });
      expect(msg({ type: 'result' })).toEqual({ kind: 'persist', dbType: 'result' });
    });

    it('persists non-system progress-ish types as system', () => {
      expect(msg({ type: 'tool_progress' })).toEqual({ kind: 'persist', dbType: 'system' });
      expect(msg({ type: 'tool_use_summary' })).toEqual({ kind: 'persist', dbType: 'system' });
      expect(msg({ type: 'auth_status' })).toEqual({ kind: 'persist', dbType: 'system' });
      expect(msg({ type: 'rate_limit_event' })).toEqual({ kind: 'persist', dbType: 'system' });
      expect(msg({ type: 'prompt_suggestion' })).toEqual({ kind: 'persist', dbType: 'system' });
    });

    it('skips conversation_reset lifecycle messages', () => {
      expect(msg({ type: 'conversation_reset' })).toEqual({ kind: 'skip' });
    });

    it('persists ordinary system messages as system', () => {
      expect(msg({ type: 'system', subtype: 'init' })).toEqual({
        kind: 'persist',
        dbType: 'system',
      });
      expect(msg({ type: 'system' })).toEqual({ kind: 'persist', dbType: 'system' });
    });

    it('skips ignored system progress/state events', () => {
      for (const subtype of [
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
      ]) {
        expect(msg({ type: 'system', subtype })).toEqual({ kind: 'skip' });
      }
    });

    it('skips system messages flagged skip_transcript', () => {
      expect(msg({ type: 'system', subtype: 'task_started', skip_transcript: true })).toEqual({
        kind: 'skip',
      });
    });

    it('persists summarized system subtypes', () => {
      for (const subtype of ['notification', 'permission_denied', 'task_notification']) {
        expect(msg({ type: 'system', subtype })).toEqual({ kind: 'persist', dbType: 'system' });
      }
    });

    it('marks stream events for separate accumulation', () => {
      expect(msg({ type: 'stream_event' })).toEqual({ kind: 'stream_event' });
    });

    it('degrades unknown future types to system persistence at runtime', () => {
      expect(msg({ type: 'some_future_type' })).toEqual({ kind: 'persist', dbType: 'system' });
    });
  });

  describe('isIgnoredSystemMessage', () => {
    it('returns true for every ignored subtype', () => {
      expect(isIgnoredSystemMessage({ type: 'system', subtype: 'thinking_tokens' })).toBe(true);
      expect(isIgnoredSystemMessage({ type: 'system', subtype: 'task_progress' })).toBe(true);
      expect(isIgnoredSystemMessage({ type: 'system', subtype: 'commands_changed' })).toBe(true);
    });

    it('returns true for any system message flagged skip_transcript', () => {
      expect(
        isIgnoredSystemMessage({ type: 'system', subtype: 'task_started', skip_transcript: true })
      ).toBe(true);
    });

    it('returns false for system messages we render', () => {
      expect(isIgnoredSystemMessage({ type: 'system', subtype: 'init' })).toBe(false);
      expect(isIgnoredSystemMessage({ type: 'system', subtype: 'notification' })).toBe(false);
      expect(isIgnoredSystemMessage({ type: 'system' })).toBe(false);
    });

    it('returns false for non-system messages and non-objects', () => {
      expect(isIgnoredSystemMessage({ type: 'assistant' })).toBe(false);
      expect(isIgnoredSystemMessage({ subtype: 'thinking_tokens' })).toBe(false);
      expect(isIgnoredSystemMessage(null)).toBe(false);
      expect(isIgnoredSystemMessage(undefined)).toBe(false);
      expect(isIgnoredSystemMessage('thinking_tokens')).toBe(false);
    });
  });

  describe('parseRetryState', () => {
    it('extracts retry state from an api_retry message', () => {
      expect(
        parseRetryState({
          type: 'system',
          subtype: 'api_retry',
          attempt: 2,
          max_retries: 10,
          retry_delay_ms: 1184.18,
          error_status: 529,
          error: 'overloaded',
          session_id: 'sess',
          uuid: 'u1',
        })
      ).toEqual({ attempt: 2, maxRetries: 10, errorStatus: 529, error: 'overloaded' });
    });

    it('omits optional fields when absent', () => {
      expect(
        parseRetryState({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 5 })
      ).toEqual({ attempt: 1, maxRetries: 5, errorStatus: undefined, error: undefined });
    });

    it('accepts a null error_status (connection error / timeout) as undefined', () => {
      // The SDK sends error_status: null for connection errors with no HTTP
      // response; this must parse rather than failing the whole object.
      expect(
        parseRetryState({
          type: 'system',
          subtype: 'api_retry',
          attempt: 4,
          max_retries: 10,
          error_status: null,
          error: 'unknown',
        })
      ).toEqual({ attempt: 4, maxRetries: 10, errorStatus: undefined, error: 'unknown' });
    });

    it('returns null for non-retry messages', () => {
      expect(parseRetryState({ type: 'system', subtype: 'notification' })).toBeNull();
      expect(parseRetryState({ type: 'assistant' })).toBeNull();
      expect(parseRetryState(null)).toBeNull();
      // Missing required attempt/max_retries fields.
      expect(parseRetryState({ type: 'system', subtype: 'api_retry' })).toBeNull();
    });
  });

  describe('formatRetryReason', () => {
    it('maps canonical SDK error codes to friendly labels', () => {
      expect(formatRetryReason({ attempt: 1, maxRetries: 10, error: 'overloaded' })).toBe(
        'overloaded'
      );
      expect(formatRetryReason({ attempt: 1, maxRetries: 10, error: 'rate_limit' })).toBe(
        'rate limited'
      );
      expect(formatRetryReason({ attempt: 1, maxRetries: 10, error: 'server_error' })).toBe(
        'server error'
      );
    });

    it('falls back to HTTP status when no error code matches', () => {
      expect(formatRetryReason({ attempt: 1, maxRetries: 10, errorStatus: 529 })).toBe(
        'overloaded'
      );
      expect(formatRetryReason({ attempt: 1, maxRetries: 10, errorStatus: 429 })).toBe(
        'rate limited'
      );
    });

    it('humanizes other known error codes', () => {
      expect(formatRetryReason({ attempt: 1, maxRetries: 10, error: 'model_not_found' })).toBe(
        'model not found'
      );
    });

    it('returns null when nothing is known', () => {
      expect(formatRetryReason({ attempt: 1, maxRetries: 10 })).toBeNull();
      expect(formatRetryReason({ attempt: 1, maxRetries: 10, error: 'unknown' })).toBeNull();
    });
  });
});
