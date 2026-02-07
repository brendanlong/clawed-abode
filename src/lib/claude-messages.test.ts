import { describe, it, expect } from 'vitest';
import {
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ContentBlockSchema,
  AssistantContentSchema,
  UserContentSchema,
  SystemInitContentSchema,
  SystemErrorContentSchema,
  ResultContentSchema,
  StoredMessageSchema,
  parseStoredMessage,
  parseClaudeStreamLine,
  getMessageType,
  buildToolResultMap,
  AssistantMessage,
  UserMessage,
  SystemMessage,
  ResultMessage,
  RawMessage,
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

    it('should return error for unknown type', () => {
      const result = parseClaudeStreamLine({ type: 'unknown' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown message type');
      }
    });
  });

  describe('getMessageType', () => {
    it('should return correct type for known types', () => {
      expect(getMessageType({ type: 'assistant' })).toBe('assistant');
      expect(getMessageType({ type: 'user' })).toBe('user');
      expect(getMessageType({ type: 'result' })).toBe('result');
      expect(getMessageType({ type: 'system' })).toBe('system');
    });

    it('should return system for unknown types', () => {
      expect(getMessageType({ type: 'unknown' })).toBe('system');
      expect(getMessageType(null)).toBe('system');
      expect(getMessageType(undefined)).toBe('system');
      expect(getMessageType('string')).toBe('system');
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
