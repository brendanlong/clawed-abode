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
  summarizeSystemMessage,
  hasRenderableAssistantContent,
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

  it('extracts text from string message.content and strips XML tags', () => {
    const content: MessageContent = {
      message: {
        content: '<local-command-stdout>\n## Context Usage\nSome content\n</local-command-stdout>',
      },
    };
    expect(extractTextContent(content)).toBe('## Context Usage\nSome content');
  });

  it('extracts text from string message.content without XML tags', () => {
    const content: MessageContent = {
      message: {
        content: 'plain text content',
      },
    };
    expect(extractTextContent(content)).toBe('plain text content');
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

  it('recognizes user messages with string message.content (e.g., /context output)', () => {
    const content: MessageContent = {
      message: {
        role: 'user',
        content: '<local-command-stdout>\n## Context Usage\n</local-command-stdout>',
      },
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

  it('returns stripped string message.content for user messages with local command output', () => {
    const content: MessageContent = {
      message: {
        role: 'user',
        content: '<local-command-stdout>\n## Context Usage\nSome content\n</local-command-stdout>',
      },
    };
    expect(getDisplayContent(content, 'user')).toBe('## Context Usage\nSome content');
  });

  it('returns content.content for system messages', () => {
    const content: MessageContent = { content: 'system text' };
    expect(getDisplayContent(content, 'system')).toBe('system text');
  });
});

describe('hasRenderableAssistantContent', () => {
  it('returns false when the only block is empty thinking', () => {
    const content: MessageContent = {
      message: { content: [{ type: 'thinking', thinking: '', signature: 'sig' }] },
    };
    expect(hasRenderableAssistantContent(content)).toBe(false);
  });

  it('returns false for whitespace-only text and an empty block array', () => {
    expect(
      hasRenderableAssistantContent({ message: { content: [{ type: 'text', text: '   ' }] } })
    ).toBe(false);
    expect(hasRenderableAssistantContent({ message: { content: [] } })).toBe(false);
  });

  it('returns true when any block has real content', () => {
    expect(
      hasRenderableAssistantContent({
        message: {
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: 'hi' },
          ],
        },
      })
    ).toBe(true);
    expect(
      hasRenderableAssistantContent({
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      })
    ).toBe(true);
    expect(
      hasRenderableAssistantContent({
        message: { content: [{ type: 'redacted_thinking' }] },
      })
    ).toBe(true);
  });

  it('returns true for non-array content (handled elsewhere)', () => {
    expect(hasRenderableAssistantContent({ content: 'plain' })).toBe(true);
  });

  it('does not throw on null content or null blocks', () => {
    expect(hasRenderableAssistantContent(null as unknown as MessageContent)).toBe(true);
    expect(
      hasRenderableAssistantContent({
        message: { content: [null, { type: 'text', text: 'hi' }] as never },
      })
    ).toBe(true);
  });
});

describe('summarizeSystemMessage', () => {
  // SDK system messages use loose fields (some, like `message`, collide with the
  // typed MessageContent wrapper), so build them as plain objects.
  const sys = (c: Record<string, unknown>) =>
    summarizeSystemMessage(c as unknown as MessageContent);

  it('summarizes a notification, escalating priority to warn', () => {
    expect(sys({ subtype: 'notification', text: 'Heads up', priority: 'high' })).toEqual({
      label: 'Notification',
      body: 'Heads up',
      level: 'warn',
    });
    expect(sys({ subtype: 'notification', text: 'fyi', priority: 'low' })).toEqual({
      label: 'Notification',
      body: 'fyi',
      level: 'info',
    });
  });

  it('summarizes permission_denied with tool and message', () => {
    expect(
      sys({ subtype: 'permission_denied', tool_name: 'Bash', message: 'not allowed' })
    ).toEqual({ label: 'Permission denied', body: 'Bash: not allowed', level: 'warn' });
  });

  it('summarizes subagent start and completion', () => {
    expect(
      sys({ subtype: 'task_started', subagent_type: 'Explore', description: 'find usages' })
    ).toEqual({ label: 'Subagent started', body: 'Explore: find usages', level: 'info' });
    expect(sys({ subtype: 'task_notification', status: 'failed', summary: 'boom' })).toEqual({
      label: 'Subagent failed',
      body: 'boom',
      level: 'warn',
    });
  });

  it('summarizes a failed plugin install, extracting an object error', () => {
    expect(
      sys({ subtype: 'plugin_install', name: 'foo', status: 'failed', error: { message: 'nope' } })
    ).toEqual({ label: 'Plugin: foo', body: 'failed — nope', level: 'warn' });
  });

  it('summarizes a mirror error from a string', () => {
    expect(sys({ subtype: 'mirror_error', error: 'disk full' })).toEqual({
      label: 'Mirror error',
      body: 'disk full',
      level: 'warn',
    });
  });

  it('falls back to a humanized label for unknown subtypes', () => {
    expect(sys({ subtype: 'some_future_thing' })).toEqual({
      label: 'Some Future Thing',
      body: undefined,
      level: 'info',
    });
  });

  it('labels top-level types (no subtype) from the message type', () => {
    expect(sys({ type: 'prompt_suggestion', suggestion: 'try this' })).toEqual({
      label: 'Prompt Suggestion',
      body: undefined,
      level: 'info',
    });
  });

  it('uses string content as the body for unknown subtypes', () => {
    expect(sys({ subtype: 'mystery', content: 'raw text' })).toEqual({
      label: 'Mystery',
      body: 'raw text',
      level: 'info',
    });
  });
});
