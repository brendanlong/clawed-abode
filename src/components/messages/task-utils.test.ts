import { describe, it, expect } from 'vitest';
import { parseTaskOutput, extractSubagentToolCalls } from './task-utils';
import type { SubagentMessage } from './MessageListContext';

describe('parseTaskOutput', () => {
  it('returns empty text for non-string, non-array input', () => {
    expect(parseTaskOutput(undefined)).toEqual({ text: '' });
    expect(parseTaskOutput(null)).toEqual({ text: '' });
    expect(parseTaskOutput(42)).toEqual({ text: '' });
  });

  it('parses a plain string output', () => {
    const result = parseTaskOutput('Some result text');
    expect(result.text).toBe('Some result text');
    expect(result.agentId).toBeUndefined();
  });

  it('extracts agentId from string output', () => {
    const result = parseTaskOutput('agentId: abc123');
    expect(result.text).toBe('agentId: abc123');
    expect(result.agentId).toBe('abc123');
  });

  it('parses array output with text content blocks', () => {
    const output = [{ type: 'text', text: 'Summary of work done.' }];
    const result = parseTaskOutput(output);
    expect(result.text).toBe('Summary of work done.');
  });

  it('extracts agentId and usage from metadata block', () => {
    const output = [
      { type: 'text', text: 'Summary of work done.' },
      {
        type: 'text',
        text: 'agentId: xyz789\n<usage>total_tokens: 50000\ntool_uses: 10\nduration_ms: 30000</usage>',
      },
    ];
    const result = parseTaskOutput(output);
    expect(result.text).toBe('Summary of work done.');
    expect(result.agentId).toBe('xyz789');
    expect(result.usage).toEqual({
      totalTokens: 50000,
      toolUses: 10,
      durationMs: 30000,
    });
  });

  it('handles metadata block without usage', () => {
    const output = [
      { type: 'text', text: 'Result' },
      { type: 'text', text: 'agentId: abc' },
    ];
    const result = parseTaskOutput(output);
    expect(result.text).toBe('Result');
    expect(result.agentId).toBe('abc');
    expect(result.usage).toBeUndefined();
  });

  it('handles partial usage data', () => {
    const output = [
      {
        type: 'text',
        text: 'agentId: x\n<usage>total_tokens: 1000</usage>',
      },
    ];
    const result = parseTaskOutput(output);
    expect(result.usage).toEqual({
      totalTokens: 1000,
      toolUses: undefined,
      durationMs: undefined,
    });
  });

  it('joins multiple text parts with double newlines', () => {
    const output = [
      { type: 'text', text: 'Part 1' },
      { type: 'text', text: 'Part 2' },
    ];
    const result = parseTaskOutput(output);
    expect(result.text).toBe('Part 1\n\nPart 2');
  });
});

describe('extractSubagentToolCalls', () => {
  it('returns empty array for no messages', () => {
    expect(extractSubagentToolCalls([])).toEqual([]);
  });

  it('extracts tool calls with matched results', () => {
    const messages: SubagentMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: {
          message: {
            content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
          },
        },
        sequence: 1,
      },
      {
        id: '2',
        type: 'user',
        content: {
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'file data', is_error: false },
            ],
          },
        },
        sequence: 2,
      },
    ];

    const result = extractSubagentToolCalls(messages);
    expect(result).toEqual([{ id: 't1', name: 'Read', hasResult: true, isError: false }]);
  });

  it('marks error results correctly', () => {
    const messages: SubagentMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: {
          message: {
            content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
          },
        },
        sequence: 1,
      },
      {
        id: '2',
        type: 'user',
        content: {
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'error!', is_error: true },
            ],
          },
        },
        sequence: 2,
      },
    ];

    const result = extractSubagentToolCalls(messages);
    expect(result).toEqual([{ id: 't1', name: 'Bash', hasResult: true, isError: true }]);
  });

  it('marks tool calls without results as pending', () => {
    const messages: SubagentMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: {
          message: {
            content: [{ type: 'tool_use', id: 't1', name: 'Write', input: {} }],
          },
        },
        sequence: 1,
      },
    ];

    const result = extractSubagentToolCalls(messages);
    expect(result).toEqual([{ id: 't1', name: 'Write', hasResult: false, isError: false }]);
  });

  it('handles multiple tool calls in one assistant message', () => {
    const messages: SubagentMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: {
          message: {
            content: [
              { type: 'tool_use', id: 't1', name: 'Read', input: {} },
              { type: 'tool_use', id: 't2', name: 'Grep', input: {} },
            ],
          },
        },
        sequence: 1,
      },
      {
        id: '2',
        type: 'user',
        content: {
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
              { type: 'tool_result', tool_use_id: 't2', content: 'ok' },
            ],
          },
        },
        sequence: 2,
      },
    ];

    const result = extractSubagentToolCalls(messages);
    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe('Read');
    expect(result[1]?.name).toBe('Grep');
    expect(result.every((tc) => tc.hasResult)).toBe(true);
  });

  it('ignores system and result messages', () => {
    const messages: SubagentMessage[] = [
      {
        id: '1',
        type: 'system',
        content: { subtype: 'init' },
        sequence: 1,
      },
      {
        id: '2',
        type: 'result',
        content: { subtype: 'success' },
        sequence: 2,
      },
    ];

    expect(extractSubagentToolCalls(messages)).toEqual([]);
  });
});
