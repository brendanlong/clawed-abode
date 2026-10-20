import { describe, it, expect } from 'vitest';
import {
  INLINE_TOOL_RESULT_MAX_CHARS,
  findToolResultText,
  projectMessageContent,
  summarizeToolResult,
  toolResultText,
} from './tool-result';

const big = 'x'.repeat(INLINE_TOOL_RESULT_MAX_CHARS + 1);

function toolResultMessage(blocks: unknown[], extra: Record<string, unknown> = {}) {
  return { type: 'user', message: { role: 'user', content: blocks }, ...extra };
}

describe('toolResultText', () => {
  it('passes strings through', () => {
    expect(toolResultText('hello')).toBe('hello');
  });

  it('joins text parts and labels non-text parts without their payloads', () => {
    expect(
      toolResultText([
        { type: 'text', text: 'caption' },
        { type: 'image', source: { type: 'base64', data: 'AAAA' } },
        { type: 'tool_reference', tool_name: 'Monitor' },
        { type: 'document', source: { type: 'base64', data: 'BBBB' } },
      ])
    ).toBe('caption\n\n[image]\n\nLoaded Monitor\n\n[document]');
  });

  it('skips malformed parts instead of throwing', () => {
    expect(toolResultText([null, 7, 'raw', { type: 'text', text: 'ok' }])).toBe('raw\n\nok');
  });

  it('returns an empty string for missing content', () => {
    expect(toolResultText(undefined)).toBe('');
  });
});

describe('summarizeToolResult', () => {
  it('counts Read lines without the gutter, reminders or trailing newline', () => {
    const output = '     1→a\n     2→b\n<system-reminder>\nnote\n</system-reminder>\n';
    // The reminder's tag lines go; its inner line is content, as Read shows it.
    expect(summarizeToolResult(output).readLines).toBe(3);
  });

  it('counts non-blank lines for Glob and Grep', () => {
    expect(summarizeToolResult('src/a.ts\n\n  \nsrc/b.ts\n').nonBlankLines).toBe(2);
  });

  it('sums trailing counts for Grep count mode', () => {
    expect(summarizeToolResult('src/a.ts:3\nsrc/b.ts:4\nnoise').countTotal).toBe(7);
  });

  it('counts WebSearch sources, and null for empty output', () => {
    const output =
      'Web search results for query: "q"\nLinks: [{"title":"A","url":"https://a"},{"title":"B","url":"https://b"},{"bad":1}]\nSummary';
    expect(summarizeToolResult(output).webSearchSources).toBe(2);
    expect(summarizeToolResult('').webSearchSources).toBeNull();
  });
});

describe('projectMessageContent', () => {
  it('replaces a large tool_result body with its summary, keeping status and sanitization', () => {
    const sanitization = { removed: true, warnings: ['w'], found: [] };
    const content = toolResultMessage([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: [{ type: 'text', text: big }],
        is_error: true,
        sanitization,
      },
    ]);

    expect(projectMessageContent(content)).toEqual(
      toolResultMessage([
        {
          type: 'tool_result',
          tool_use_id: 't1',
          is_error: true,
          sanitization,
          summary: summarizeToolResult(big),
        },
      ])
    );
  });

  it('keeps a body at the inline limit', () => {
    const body = 'x'.repeat(INLINE_TOOL_RESULT_MAX_CHARS - 2); // + 2 JSON quotes
    const content = toolResultMessage([{ type: 'tool_result', tool_use_id: 't1', content: body }]);
    expect(projectMessageContent(content)).toEqual(content);
  });

  it('measures the serialized body, so a large image with a short label is elided', () => {
    const image = { type: 'image', source: { type: 'base64', data: big } };
    const content = toolResultMessage([
      { type: 'tool_result', tool_use_id: 't1', content: [image] },
    ]);
    const projected = projectMessageContent(content) as ReturnType<typeof toolResultMessage>;
    expect(projected.message.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      summary: summarizeToolResult('[image]'),
    });
  });

  it('drops the SDK fields no client reads', () => {
    const user = toolResultMessage([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], {
      tool_use_result: { file: { content: big } },
    });
    expect(projectMessageContent(user)).toEqual(
      toolResultMessage([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }])
    );

    const assistant = {
      type: 'assistant',
      wire_tool_inputs: { t1: {} },
      message: { content: [{ type: 'text', text: 'hi' }], input_transformations: [{}] },
    };
    expect(projectMessageContent(assistant)).toEqual({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
  });

  it('returns content it has nothing to change in as-is', () => {
    const content = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
    expect(projectMessageContent(content)).toBe(content);
    expect(projectMessageContent('plain')).toBe('plain');
    expect(projectMessageContent(null)).toBeNull();
  });

  it('does not mutate the stored content', () => {
    const content = toolResultMessage([{ type: 'tool_result', tool_use_id: 't1', content: big }], {
      tool_use_result: {},
    });
    const before = structuredClone(content);
    projectMessageContent(content);
    expect(content).toEqual(before);
  });
});

describe('findToolResultText', () => {
  it('returns the full text of the named result', () => {
    const content = toolResultMessage([
      { type: 'tool_result', tool_use_id: 't1', content: 'one' },
      { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: big }] },
    ]);
    expect(findToolResultText(content, 't2')).toBe(big);
  });

  it('returns null when the message has no such result', () => {
    expect(findToolResultText(toolResultMessage([]), 't1')).toBeNull();
    expect(findToolResultText({ type: 'assistant' }, 't1')).toBeNull();
    expect(findToolResultText('text', 't1')).toBeNull();
  });
});
