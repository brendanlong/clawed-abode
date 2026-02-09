import { describe, it, expect } from 'vitest';
import type { MessageContent } from './types';
import {
  extractTextContent,
  isToolResultMessage,
  getToolResults,
  isRecognizedMessage,
  buildToolCalls,
  getCopyText,
  getDisplayContent,
} from './messageHelpers';

describe('extractTextContent', () => {
  it('extracts text from assistant message content array', () => {
    const content: MessageContent = {
      message: {
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: 'World' },
        ],
      },
    };
    expect(extractTextContent(content)).toBe('Hello\nWorld');
  });

  it('extracts text from simple content string', () => {
    const content: MessageContent = {
      content: 'Simple text',
    };
    expect(extractTextContent(content)).toBe('Simple text');
  });

  it('returns null when no text content exists', () => {
    const content: MessageContent = {};
    expect(extractTextContent(content)).toBeNull();
  });

  it('returns null when message content has no text blocks', () => {
    const content: MessageContent = {
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: {} }],
      },
    };
    expect(extractTextContent(content)).toBeNull();
  });

  it('skips non-text blocks in message content', () => {
    const content: MessageContent = {
      message: {
        content: [
          { type: 'text', text: 'Some text' },
          { type: 'tool_use', name: 'Read', input: {} },
        ],
      },
    };
    expect(extractTextContent(content)).toBe('Some text');
  });
});

describe('isToolResultMessage', () => {
  it('returns true for messages with tool_result content', () => {
    const content: MessageContent = {
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }],
      },
    };
    expect(isToolResultMessage(content)).toBe(true);
  });

  it('returns false for messages without tool_result content', () => {
    const content: MessageContent = {
      message: {
        content: [{ type: 'text', text: 'hello' }],
      },
    };
    expect(isToolResultMessage(content)).toBe(false);
  });

  it('returns false when message has no content array', () => {
    const content: MessageContent = {
      content: 'text',
    };
    expect(isToolResultMessage(content)).toBe(false);
  });
});

describe('getToolResults', () => {
  it('extracts tool_result blocks', () => {
    const content: MessageContent = {
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'result 1' },
          { type: 'text', text: 'hello' },
          { type: 'tool_result', tool_use_id: 'tool-2', content: 'result 2' },
        ],
      },
    };
    const results = getToolResults(content);
    expect(results).toHaveLength(2);
    expect(results[0].tool_use_id).toBe('tool-1');
    expect(results[1].tool_use_id).toBe('tool-2');
  });

  it('returns empty array when no tool_result blocks exist', () => {
    const content: MessageContent = {
      message: {
        content: [{ type: 'text', text: 'hello' }],
      },
    };
    expect(getToolResults(content)).toEqual([]);
  });

  it('returns empty array when message has no content', () => {
    const content: MessageContent = {};
    expect(getToolResults(content)).toEqual([]);
  });
});

describe('isRecognizedMessage', () => {
  it('recognizes assistant messages with valid content array', () => {
    const content: MessageContent = {
      message: { content: [{ type: 'text', text: 'hello' }] },
    };
    expect(isRecognizedMessage('assistant', content)).toEqual({
      recognized: true,
      category: 'assistant',
    });
  });

  it('rejects assistant messages without content array', () => {
    const content: MessageContent = { message: {} };
    expect(isRecognizedMessage('assistant', content)).toEqual({ recognized: false });
  });

  it('recognizes user tool result messages', () => {
    const content: MessageContent = {
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1' }],
      },
    };
    expect(isRecognizedMessage('user', content)).toEqual({
      recognized: true,
      category: 'toolResult',
    });
  });

  it('recognizes user interrupt messages', () => {
    const content: MessageContent = { subtype: 'interrupt' };
    expect(isRecognizedMessage('user', content)).toEqual({
      recognized: true,
      category: 'userInterrupt',
    });
  });

  it('recognizes user messages with content string', () => {
    const content: MessageContent = { content: 'hello' };
    expect(isRecognizedMessage('user', content)).toEqual({
      recognized: true,
      category: 'user',
    });
  });

  it('recognizes user messages with message content array', () => {
    const content: MessageContent = {
      message: { content: [{ type: 'text', text: 'hello' }] },
    };
    expect(isRecognizedMessage('user', content)).toEqual({
      recognized: true,
      category: 'user',
    });
  });

  it('rejects user messages without text content', () => {
    const content: MessageContent = {};
    expect(isRecognizedMessage('user', content)).toEqual({ recognized: false });
  });

  it('recognizes system init messages', () => {
    const content: MessageContent = {
      subtype: 'init',
      model: 'claude-3',
      session_id: 'sess-1',
    };
    expect(isRecognizedMessage('system', content)).toEqual({
      recognized: true,
      category: 'systemInit',
    });
  });

  it('rejects system init messages without required fields', () => {
    const content: MessageContent = { subtype: 'init' };
    expect(isRecognizedMessage('system', content)).toEqual({ recognized: false });
  });

  it('recognizes system error messages', () => {
    const content: MessageContent = {
      subtype: 'error',
      content: [{ type: 'text', text: 'error' }],
    };
    expect(isRecognizedMessage('system', content)).toEqual({
      recognized: true,
      category: 'systemError',
    });
  });

  it('rejects system error messages without array content', () => {
    const content: MessageContent = { subtype: 'error', content: 'string error' };
    expect(isRecognizedMessage('system', content)).toEqual({ recognized: false });
  });

  it('recognizes system compact boundary messages', () => {
    const content: MessageContent = { subtype: 'compact_boundary' };
    expect(isRecognizedMessage('system', content)).toEqual({
      recognized: true,
      category: 'systemCompactBoundary',
    });
  });

  it('recognizes hook started messages', () => {
    const content: MessageContent = { subtype: 'hook_started' };
    expect(isRecognizedMessage('system', content)).toEqual({
      recognized: true,
      category: 'hookStarted',
    });
  });

  it('recognizes hook response messages', () => {
    const content: MessageContent = { subtype: 'hook_response' };
    expect(isRecognizedMessage('system', content)).toEqual({
      recognized: true,
      category: 'hookResponse',
    });
  });

  it('recognizes generic system messages', () => {
    const content: MessageContent = { content: 'system message' };
    expect(isRecognizedMessage('system', content)).toEqual({
      recognized: true,
      category: 'system',
    });
  });

  it('recognizes result messages', () => {
    const content: MessageContent = { subtype: 'success', session_id: 'sess-1' };
    expect(isRecognizedMessage('result', content)).toEqual({
      recognized: true,
      category: 'result',
    });
  });

  it('rejects result messages without required fields', () => {
    const content: MessageContent = { subtype: 'success' };
    expect(isRecognizedMessage('result', content)).toEqual({ recognized: false });
  });

  it('rejects unknown message types', () => {
    const content: MessageContent = {};
    expect(isRecognizedMessage('unknown_type', content)).toEqual({ recognized: false });
  });
});

describe('buildToolCalls', () => {
  it('builds tool calls from assistant message content', () => {
    const content: MessageContent = {
      message: {
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/test.txt' } },
        ],
      },
    };
    const toolResults = new Map([['tool-1', { content: 'file contents', is_error: false }]]);

    const calls = buildToolCalls(content, toolResults);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: 'Read',
      id: 'tool-1',
      input: { file_path: '/test.txt' },
      output: 'file contents',
      is_error: false,
    });
  });

  it('returns empty array when no message content', () => {
    const content: MessageContent = {};
    expect(buildToolCalls(content)).toEqual([]);
  });

  it('skips non-tool_use blocks', () => {
    const content: MessageContent = {
      message: {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
        ],
      },
    };
    const calls = buildToolCalls(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('Read');
  });

  it('handles missing tool results', () => {
    const content: MessageContent = {
      message: {
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
      },
    };
    const calls = buildToolCalls(content, new Map());
    expect(calls[0].output).toBeUndefined();
    expect(calls[0].is_error).toBeUndefined();
  });
});

describe('getCopyText', () => {
  it('returns text for user messages', () => {
    const content: MessageContent = { content: 'user text' };
    expect(getCopyText(content, 'user', [])).toBe('user text');
  });

  it('returns text for assistant messages without tool calls', () => {
    const content: MessageContent = {
      message: { content: [{ type: 'text', text: 'assistant text' }] },
    };
    expect(getCopyText(content, 'assistant', [])).toBe('assistant text');
  });

  it('includes tool calls in assistant copy text', () => {
    const content: MessageContent = {
      message: { content: [{ type: 'text', text: 'Some text' }] },
    };
    const toolCalls = [{ name: 'Read', id: 'tool-1', input: { file_path: '/test.txt' } }];
    const result = getCopyText(content, 'assistant', toolCalls);
    expect(result).toContain('Some text');
    expect(result).toContain('Read');
  });

  it('returns JSON for other message types', () => {
    const content: MessageContent = { subtype: 'init', model: 'claude-3' };
    const result = getCopyText(content, 'systemInit', []);
    expect(result).toContain('"subtype"');
    expect(result).toContain('"init"');
  });
});

describe('getDisplayContent', () => {
  it('returns message.content for assistant messages', () => {
    const blocks = [{ type: 'text' as const, text: 'hello' }];
    const content: MessageContent = {
      message: { content: blocks },
    };
    expect(getDisplayContent(content, 'assistant')).toBe(blocks);
  });

  it('returns content.content for user messages', () => {
    const content: MessageContent = { content: 'user text' };
    expect(getDisplayContent(content, 'user')).toBe('user text');
  });

  it('returns content.content for system messages', () => {
    const content: MessageContent = { content: 'system text' };
    expect(getDisplayContent(content, 'system')).toBe('system text');
  });
});
