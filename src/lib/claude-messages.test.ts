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
  SystemErrorContentSchema,
  SystemCompactBoundaryContentSchema,
  ResultContentSchema,
  StoredMessageSchema,
  parseStoredMessage,
  parseClaudeStreamLine,
  classifyMessage,
  isIgnoredSystemMessage,
  buildToolResultMap,
  AssistantMessage,
  UserMessage,
  SystemMessage,
  ResultMessage,
  RawMessage,
  parseRetryState,
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

    describe('SystemErrorContentSchema', () => {
      it('should parse system error message', () => {
        const content = {
          type: 'system',
          subtype: 'error',
          content: [{ type: 'text', text: 'An error occurred' }],
        };
        const result = SystemErrorContentSchema.safeParse(content);
        expect(result.success).toBe(true);
      });
    });

    describe('SystemCompactBoundaryContentSchema', () => {
      it('should parse compact boundary message', () => {
        const content = {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: {
            trigger: 'manual',
            pre_tokens: 45000,
          },
          uuid: 'uuid-123',
          session_id: 'session-123',
        };
        const result = SystemCompactBoundaryContentSchema.safeParse(content);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.compact_metadata.trigger).toBe('manual');
          expect(result.data.compact_metadata.pre_tokens).toBe(45000);
        }
      });

      it('should parse auto-triggered compact boundary', () => {
        const content = {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: {
            trigger: 'auto',
            pre_tokens: 100000,
          },
          uuid: 'uuid-456',
          session_id: 'session-456',
        };
        const result = SystemCompactBoundaryContentSchema.safeParse(content);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.compact_metadata.trigger).toBe('auto');
        }
      });

      it('should reject invalid trigger type', () => {
        const content = {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: {
            trigger: 'invalid',
            pre_tokens: 45000,
          },
          uuid: 'uuid-123',
          session_id: 'session-123',
        };
        const result = SystemCompactBoundaryContentSchema.safeParse(content);
        expect(result.success).toBe(false);
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

  describe('StoredMessageSchema', () => {
    it('should parse stored message with Date', () => {
      const msg = {
        id: 'msg-1',
        sessionId: 'session-1',
        sequence: 1,
        type: 'assistant',
        content: { type: 'assistant' },
        createdAt: new Date('2024-01-01'),
      };
      const result = StoredMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it('should parse stored message with string date', () => {
      const msg = {
        id: 'msg-1',
        sessionId: 'session-1',
        sequence: 1,
        type: 'assistant',
        content: { type: 'assistant' },
        createdAt: '2024-01-01T00:00:00Z',
      };
      const result = StoredMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.createdAt).toBeInstanceOf(Date);
      }
    });
  });

  describe('parseStoredMessage', () => {
    const baseStored = {
      id: 'msg-1',
      sessionId: 'session-1',
      sequence: 1,
      createdAt: new Date('2024-01-01'),
    };

    it('should parse assistant message', () => {
      const stored = {
        ...baseStored,
        type: 'assistant' as const,
        content: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello' }],
          },
          session_id: 'session-1',
          uuid: 'uuid-1',
        },
      };

      const parsed = parseStoredMessage(stored);
      expect(parsed).toBeInstanceOf(AssistantMessage);
      expect(parsed.messageType).toBe('assistant');
      if (parsed instanceof AssistantMessage) {
        expect(parsed.getText()).toBe('Hello');
      }
    });

    it('should parse user message with tool results', () => {
      const stored = {
        ...baseStored,
        type: 'user' as const,
        content: {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }],
          },
          session_id: 'session-1',
          uuid: 'uuid-1',
        },
      };

      const parsed = parseStoredMessage(stored);
      expect(parsed).toBeInstanceOf(UserMessage);
      if (parsed instanceof UserMessage) {
        expect(parsed.isToolResult()).toBe(true);
        expect(parsed.getToolResults()).toHaveLength(1);
      }
    });

    it('should parse system init message', () => {
      const stored = {
        ...baseStored,
        type: 'system' as const,
        content: {
          type: 'system',
          subtype: 'init',
          cwd: '/workspace',
          session_id: 'session-1',
          model: 'claude-3-5-sonnet',
        },
      };

      const parsed = parseStoredMessage(stored);
      expect(parsed).toBeInstanceOf(SystemMessage);
      if (parsed instanceof SystemMessage) {
        expect(parsed.isInit()).toBe(true);
        expect(parsed.getInitInfo()?.model).toBe('claude-3-5-sonnet');
      }
    });

    it('should parse system error message', () => {
      const stored = {
        ...baseStored,
        type: 'system' as const,
        content: {
          type: 'system',
          subtype: 'error',
          content: [{ type: 'text', text: 'Something went wrong' }],
        },
      };

      const parsed = parseStoredMessage(stored);
      expect(parsed).toBeInstanceOf(SystemMessage);
      if (parsed instanceof SystemMessage) {
        expect(parsed.isError()).toBe(true);
        expect(parsed.getErrorText()).toBe('Something went wrong');
      }
    });

    it('should parse compact boundary message', () => {
      const stored = {
        ...baseStored,
        type: 'system' as const,
        content: {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: {
            trigger: 'manual',
            pre_tokens: 45000,
          },
          uuid: 'uuid-1',
          session_id: 'session-1',
        },
      };

      const parsed = parseStoredMessage(stored);
      expect(parsed).toBeInstanceOf(SystemMessage);
      if (parsed instanceof SystemMessage) {
        expect(parsed.isCompactBoundary()).toBe(true);
        expect(parsed.isInit()).toBe(false);
        expect(parsed.isError()).toBe(false);
        const compactInfo = parsed.getCompactInfo();
        expect(compactInfo).toBeDefined();
        expect(compactInfo!.trigger).toBe('manual');
        expect(compactInfo!.preTokens).toBe(45000);
      }
    });

    it('should parse result message', () => {
      const stored = {
        ...baseStored,
        type: 'result' as const,
        content: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-1',
          duration_ms: 5000,
          num_turns: 3,
          total_cost_usd: 0.05,
        },
      };

      const parsed = parseStoredMessage(stored);
      expect(parsed).toBeInstanceOf(ResultMessage);
      if (parsed instanceof ResultMessage) {
        expect(parsed.isSuccess).toBe(true);
        expect(parsed.costUsd).toBe(0.05);
        expect(parsed.durationMs).toBe(5000);
        expect(parsed.numTurns).toBe(3);
      }
    });

    it('should return RawMessage for invalid content', () => {
      const stored = {
        ...baseStored,
        type: 'assistant' as const,
        content: { invalid: 'data' },
      };

      const parsed = parseStoredMessage(stored);
      expect(parsed).toBeInstanceOf(RawMessage);
      if (parsed instanceof RawMessage) {
        expect(parsed.isParseError).toBe(true);
      }
    });

    it('should return RawMessage for unknown type', () => {
      const stored = {
        ...baseStored,
        type: 'unknown' as 'system',
        content: { something: 'data' },
      };

      const parsed = parseStoredMessage(stored);
      expect(parsed).toBeInstanceOf(RawMessage);
    });
  });

  describe('parseClaudeStreamLine', () => {
    it('should parse assistant stream line', () => {
      const json = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        },
        session_id: 'session-1',
        uuid: 'uuid-1',
      };

      const result = parseClaudeStreamLine(json);
      expect(result.success).toBe(true);
    });

    it('should parse result stream line', () => {
      const json = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'session-1',
      };

      const result = parseClaudeStreamLine(json);
      expect(result.success).toBe(true);
    });

    it('should return error for invalid JSON', () => {
      const result = parseClaudeStreamLine(null);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid JSON');
      }
    });

    it('should parse compact boundary stream line', () => {
      const json = {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: {
          trigger: 'manual',
          pre_tokens: 45000,
        },
        uuid: 'uuid-1',
        session_id: 'session-1',
      };

      const result = parseClaudeStreamLine(json);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('system');
        expect('subtype' in result.data && result.data.subtype).toBe('compact_boundary');
      }
    });

    it('should parse generic system messages and preserve extra fields', () => {
      const statusMessage = {
        type: 'system',
        subtype: 'status',
        status: 'compacting',
        permissionMode: 'bypassPermissions',
        uuid: 'uuid-1',
        session_id: 'session-1',
      };

      const result = parseClaudeStreamLine(statusMessage);
      expect(result.success).toBe(true);
      if (result.success) {
        // Passthrough should preserve extra fields like status and permissionMode
        const data = result.data as Record<string, unknown>;
        expect(data.status).toBe('compacting');
        expect(data.permissionMode).toBe('bypassPermissions');
        expect(data.uuid).toBe('uuid-1');
      }
    });

    it('should parse tool_progress messages and preserve original fields', () => {
      const json = {
        type: 'tool_progress',
        tool_use_id: 'tool-1',
        tool_name: 'Bash',
        parent_tool_use_id: null,
        elapsed_time_seconds: 5,
        uuid: 'uuid-1',
        session_id: 'session-1',
      };

      const result = parseClaudeStreamLine(json);
      expect(result.success).toBe(true);
      if (result.success) {
        // Original fields should be preserved via passthrough
        const data = result.data as Record<string, unknown>;
        expect(data.subtype).toBe('tool_progress');
        expect(data.tool_use_id).toBe('tool-1');
        expect(data.tool_name).toBe('Bash');
        expect(data.elapsed_time_seconds).toBe(5);
      }
    });

    it('should parse tool_use_summary messages', () => {
      const json = {
        type: 'tool_use_summary',
        summary: 'Read 3 files',
        preceding_tool_use_ids: ['tool-1', 'tool-2'],
        uuid: 'uuid-1',
        session_id: 'session-1',
      };

      const result = parseClaudeStreamLine(json);
      expect(result.success).toBe(true);
    });

    it('should parse auth_status messages', () => {
      const json = {
        type: 'auth_status',
        isAuthenticating: false,
        output: [],
        uuid: 'uuid-1',
        session_id: 'session-1',
      };

      const result = parseClaudeStreamLine(json);
      expect(result.success).toBe(true);
    });

    it('should return error for unknown type', () => {
      const result = parseClaudeStreamLine({ type: 'unknown' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown message type');
      }
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

    it('returns null for non-retry messages', () => {
      expect(parseRetryState({ type: 'system', subtype: 'notification' })).toBeNull();
      expect(parseRetryState({ type: 'assistant' })).toBeNull();
      expect(parseRetryState(null)).toBeNull();
      // Missing required attempt/max_retries fields.
      expect(parseRetryState({ type: 'system', subtype: 'api_retry' })).toBeNull();
    });
  });

  describe('buildToolResultMap', () => {
    it('should build map from user messages with tool results', () => {
      const baseStored = {
        id: 'msg-1',
        sessionId: 'session-1',
        sequence: 1,
        createdAt: new Date(),
      };

      const userContent = {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: [
            { type: 'tool_result' as const, tool_use_id: 'tool-1', content: 'result 1' },
            {
              type: 'tool_result' as const,
              tool_use_id: 'tool-2',
              content: 'error',
              is_error: true,
            },
          ],
        },
        session_id: 'session-1',
        uuid: 'uuid-1',
      };

      const userMsg = new UserMessage(
        baseStored.id,
        baseStored.sessionId,
        baseStored.sequence,
        baseStored.createdAt,
        userContent
      );

      const map = buildToolResultMap([userMsg]);

      expect(map.get('tool-1')).toEqual({ content: 'result 1', is_error: undefined });
      expect(map.get('tool-2')).toEqual({ content: 'error', is_error: true });
    });

    it('should ignore non-user messages', () => {
      const systemContent = {
        type: 'system' as const,
        subtype: 'init' as const,
        cwd: '/workspace',
        session_id: 'session-1',
        model: 'claude-3-5-sonnet',
      };

      const systemMsg = new SystemMessage('msg-1', 'session-1', 1, new Date(), systemContent);

      const map = buildToolResultMap([systemMsg]);
      expect(map.size).toBe(0);
    });
  });

  describe('AssistantMessage methods', () => {
    const createAssistantMessage = (content: unknown[]) => {
      return new AssistantMessage('msg-1', 'session-1', 1, new Date(), {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: content as AssistantMessage['content']['message']['content'],
          model: 'claude-3-5-sonnet',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        session_id: 'session-1',
        uuid: 'uuid-1',
      });
    };

    it('getText should concatenate all text blocks', () => {
      const msg = createAssistantMessage([
        { type: 'text', text: 'First part' },
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        { type: 'text', text: 'Second part' },
      ]);

      expect(msg.getText()).toBe('First part\nSecond part');
    });

    it('getToolUses should return all tool use blocks', () => {
      const msg = createAssistantMessage([
        { type: 'text', text: 'Text' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a.ts' } },
        { type: 'tool_use', id: 't2', name: 'Write', input: { file: 'b.ts' } },
      ]);

      const tools = msg.getToolUses();
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('Read');
      expect(tools[1].name).toBe('Write');
    });

    it('should expose model and usage', () => {
      const msg = createAssistantMessage([{ type: 'text', text: 'Hello' }]);
      expect(msg.model).toBe('claude-3-5-sonnet');
      expect(msg.usage?.input_tokens).toBe(100);
    });
  });

  describe('RawMessage', () => {
    it('should format JSON content', () => {
      const raw = new RawMessage('msg-1', 'session-1', 1, new Date(), { key: 'value' });
      expect(raw.getFormattedJson()).toBe('{\n  "key": "value"\n}');
    });

    it('should handle non-JSON content', () => {
      const circular = { self: undefined as unknown };
      circular.self = circular; // Create circular reference
      const raw = new RawMessage('msg-1', 'session-1', 1, new Date(), circular);
      // Should not throw, returns string representation
      expect(typeof raw.getFormattedJson()).toBe('string');
    });
  });
});
