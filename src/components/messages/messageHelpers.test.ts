import { describe, it, expect } from 'vitest';
import type { MessageContent } from './types';
import {
  extractTextContent,
  isRecognizedMessage,
  isOwnPromptMessage,
  buildToolCalls,
  getCopyText,
  getDisplayContent,
  isToolCallOnlyMessage,
  groupSubagentMessages,
  computeSubagentPlacements,
  toolUseBlocks,
  buildToolResultMap,
  collectSubagentLifecycles,
  getLatestTodoWriteId,
  getPlanContentByToolUseId,
  buildTranscriptLayout,
  collectRetractedMessages,
  type SubagentLifecycle,
} from './messageHelpers';
import type { ContentBlock, DisplayMessage } from './types';
import { inlineResult } from '@/test/tool-result-fixtures';
import { summarizeToolResult } from '@/lib/tool-result';

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

  it('includes progress updates (thinking with text) but not empty reasoning blocks', () => {
    const content: MessageContent = {
      message: {
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'thinking', thinking: 'Found it.' },
        ],
      },
    };
    expect(extractTextContent(content)).toBe('Found it.');
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

describe('isOwnPromptMessage', () => {
  it('excludes task notifications', () => {
    const content: MessageContent = {
      message: { role: 'user', content: '<task-notification>…</task-notification>' },
      origin: { kind: 'task-notification', producer: 'session-task' },
    };
    expect(isOwnPromptMessage({ type: 'user', content })).toBe(false);
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

  it('gives tool result messages no category (they render on their call)', () => {
    const content: MessageContent = {
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1' }],
      },
    };
    expect(isRecognizedMessage('user', content)).toEqual({ recognized: false });
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

  it("recognizes task notifications apart from the user's own prompts", () => {
    const content: MessageContent = {
      message: { role: 'user', content: '<task-notification>…</task-notification>' },
      origin: { kind: 'task-notification', producer: 'session-task' },
    };
    expect(isRecognizedMessage('user', content)).toEqual({
      recognized: true,
      category: 'taskNotification',
    });
  });

  it('rejects user messages without text content', () => {
    const content: MessageContent = {};
    expect(isRecognizedMessage('user', content)).toEqual({ recognized: false });
  });

  it('does not specially recognize system init messages (hidden from transcript)', () => {
    const content: MessageContent = {
      subtype: 'init',
      model: 'claude-3',
      session_id: 'sess-1',
    };
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

  it('recognizes model_refusal_fallback messages', () => {
    const content: MessageContent = {
      subtype: 'model_refusal_fallback',
      original_model: 'claude-fable-5',
      fallback_model: 'claude-opus-4-8',
    };
    expect(isRecognizedMessage('system', content)).toEqual({
      recognized: true,
      category: 'systemRefusalFallback',
    });
  });

  it('does not specially recognize hook or generic system messages (hidden from transcript)', () => {
    // init, hooks, and generic notices no longer get a dedicated category — they
    // are hidden upstream by isHiddenSystemMessage, so isRecognizedMessage only
    // still classifies the system subtypes that actually render (error, compact).
    expect(isRecognizedMessage('system', { subtype: 'hook_started' })).toEqual({
      recognized: false,
    });
    expect(isRecognizedMessage('system', { subtype: 'hook_response' })).toEqual({
      recognized: false,
    });
    expect(isRecognizedMessage('system', { content: 'system message' })).toEqual({
      recognized: false,
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
    const result = inlineResult('file contents', false);
    const toolResults = new Map([['tool-1', result]]);

    const calls = buildToolCalls(content, toolResults);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: 'Read',
      id: 'tool-1',
      input: { file_path: '/test.txt' },
      result,
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
    expect(calls[0].result).toBeUndefined();
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
    const content: MessageContent = { subtype: 'success', session_id: 'sess-1' };
    const result = getCopyText(content, 'result', []);
    expect(result).toContain('"subtype"');
    expect(result).toContain('"success"');
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

  it('returns content.content for non-user/assistant messages', () => {
    const content: MessageContent = { content: 'system text' };
    expect(getDisplayContent(content, 'systemError')).toBe('system text');
  });
});

describe('isToolCallOnlyMessage', () => {
  const assistant = (content: MessageContent['message']): MessageContent => ({ message: content });

  it('is true for an assistant message with only tool_use blocks', () => {
    expect(
      isToolCallOnlyMessage(
        assistant({ content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] })
      )
    ).toBe(true);
  });

  it('is false when there is visible text alongside the tool call', () => {
    expect(
      isToolCallOnlyMessage(
        assistant({
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          ],
        })
      )
    ).toBe(false);
  });

  it('ignores empty/whitespace text blocks', () => {
    expect(
      isToolCallOnlyMessage(
        assistant({
          content: [
            { type: 'text', text: '   ' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          ],
        })
      )
    ).toBe(true);
  });

  it('is false when a progress update (thinking with text) precedes the tool', () => {
    expect(
      isToolCallOnlyMessage(
        assistant({
          content: [
            { type: 'thinking', thinking: 'Checking the config.' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          ],
        })
      )
    ).toBe(false);
  });

  it('is false when there are no tool_use blocks', () => {
    expect(isToolCallOnlyMessage(assistant({ content: [{ type: 'text', text: 'hi' }] }))).toBe(
      false
    );
    expect(isToolCallOnlyMessage({} as MessageContent)).toBe(false);
  });

  it('is false when a redacted_thinking or server_tool_use block renders alongside the tool', () => {
    // These render their own visible indicator above the tool call, so the row is
    // not purely a tool call and should keep normal spacing.
    expect(
      isToolCallOnlyMessage(
        assistant({
          content: [
            { type: 'redacted_thinking', data: 'xxx' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          ] as never,
        })
      )
    ).toBe(false);
    expect(
      isToolCallOnlyMessage(
        assistant({
          content: [
            { type: 'server_tool_use', id: 's1', name: 'advisor', input: {} },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          ] as never,
        })
      )
    ).toBe(false);
  });
});

describe('groupSubagentMessages', () => {
  const msg = (id: string, parent: string | null): DisplayMessage => ({
    id,
    type: 'assistant',
    sequence: 0,
    createdAt: new Date(0),
    content: { parent_tool_use_id: parent },
  });

  it('groups messages by parent_tool_use_id, dropping top-level messages', () => {
    const groups = groupSubagentMessages([
      msg('a', null),
      msg('b', 'task-1'),
      msg('c', 'task-1'),
      msg('d', 'task-2'),
    ]);
    expect([...groups.keys()].sort()).toEqual(['task-1', 'task-2']);
    expect(groups.get('task-1')!.map((m) => m.id)).toEqual(['b', 'c']);
    expect(groups.get('task-2')!.map((m) => m.id)).toEqual(['d']);
  });

  it('returns an empty map when there are no subagent messages', () => {
    expect(groupSubagentMessages([msg('a', null)]).size).toBe(0);
  });
});

describe('computeSubagentPlacements', () => {
  const life = (
    toolUseId: string,
    spawnSequence: number,
    over: Partial<SubagentLifecycle> = {}
  ): SubagentLifecycle => ({
    toolUseId,
    spawnSequence,
    isBackground: false,
    notificationSequence: null,
    lastChildSequence: null,
    resultSequence: null,
    ...over,
  });

  it('relocates a finished foreground subagent to its tool_result when work interleaved', () => {
    const { relocatedIds, finished, running } = computeSubagentPlacements(
      [life('task-1', 6, { resultSequence: 50 })],
      [6, 11, 14, 60], // 11 and 14 are between spawn and finish
      false
    );
    expect(relocatedIds.has('task-1')).toBe(true);
    expect(finished).toEqual([{ toolUseId: 'task-1', atSequence: 50 }]);
    expect(running).toEqual([]);
  });

  it('keeps a finished subagent inline at spawn when nothing interleaved (foreground wait)', () => {
    const { relocatedIds, finished } = computeSubagentPlacements(
      [life('task-1', 6, { resultSequence: 50 })],
      [6, 60], // no row strictly between 6 and 50
      false
    );
    expect(relocatedIds.has('task-1')).toBe(false);
    expect(finished).toEqual([]);
  });

  it('uses the terminal task_notification as the finish point over the launch ack', () => {
    // Background subagent: tool_result (ack) at 9, real completion notification at 80.
    const { finished } = computeSubagentPlacements(
      [
        life('task-1', 6, {
          isBackground: true,
          resultSequence: 9,
          lastChildSequence: 70,
          notificationSequence: 80,
        }),
      ],
      [6, 20, 40], // interleaved
      false
    );
    expect(finished).toEqual([{ toolUseId: 'task-1', atSequence: 80 }]);
  });

  it('settles a done background subagent (no notification, session idle) at its last child', () => {
    // The real reported case: async Explore, ack at 9, children out to 100, no
    // notification persisted, session no longer live.
    const { relocatedIds, finished, running } = computeSubagentPlacements(
      [life('task-1', 6, { isBackground: true, resultSequence: 9, lastChildSequence: 100 })],
      [6, 11, 14, 50, 120], // main-agent work interleaved between 6 and 100
      false
    );
    expect(relocatedIds.has('task-1')).toBe(true);
    expect(finished).toEqual([{ toolUseId: 'task-1', atSequence: 100 }]);
    expect(running).toEqual([]);
  });

  it('pins a running background subagent while the session is live', () => {
    const { relocatedIds, running, finished } = computeSubagentPlacements(
      [life('task-1', 6, { isBackground: true, resultSequence: 9, lastChildSequence: 100 })],
      [6, 11, 14],
      true
    );
    expect(relocatedIds.has('task-1')).toBe(true);
    expect(running).toEqual(['task-1']);
    expect(finished).toEqual([]);
  });

  it('never pins a foreground subagent — it stays inline whether the session is live or not', () => {
    // A synchronous subagent blocks the main agent, so there is no concurrent
    // traffic to escape past; relocating it would only add redundant chrome.
    for (const live of [true, false]) {
      const { relocatedIds, running, finished } = computeSubagentPlacements(
        [life('t', 6)], // foreground, no result yet
        [6, 11],
        live
      );
      expect(running).toEqual([]);
      expect(finished).toEqual([]);
      expect(relocatedIds.has('t')).toBe(false);
    }
  });

  it('sorts multiple finished boxes by finish position and preserves running spawn order', () => {
    const { finished, running } = computeSubagentPlacements(
      [
        life('a', 1, { resultSequence: 90 }),
        life('b', 2, { resultSequence: 40 }),
        life('c', 3, { isBackground: true }),
      ],
      [1, 2, 3, 20, 50, 70], // interleaving rows for both a and b
      true
    );
    // a finishes at 90, b at 40 → sorted by finish sequence
    expect(finished.map((f) => f.toolUseId)).toEqual(['b', 'a']);
    // c is background with no notification and the session is live → pinned
    expect(running).toEqual(['c']);
  });
});

// Fixtures for the transcript-scanning helpers. Ids double as sequences so the
// expectations read naturally.
function assistant(
  sequence: number,
  blocks: ContentBlock[],
  parentToolUseId: string | null = null
): DisplayMessage {
  return {
    id: `m${sequence}`,
    type: 'assistant',
    sequence,
    createdAt: new Date(0),
    content: { parent_tool_use_id: parentToolUseId, message: { content: blocks } },
  };
}

function toolUse(id: string, name: string, input: unknown = {}): ContentBlock {
  return { type: 'tool_use', id, name, input };
}

function toolResultMessage(sequence: number, results: ContentBlock[]): DisplayMessage {
  return {
    id: `m${sequence}`,
    type: 'user',
    sequence,
    createdAt: new Date(0),
    content: { message: { content: results } },
  };
}

function toolResult(toolUseId: string, content?: string, isError?: boolean): ContentBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError };
}

function system(sequence: number, subtype: string, toolUseId?: string): DisplayMessage {
  return {
    id: `m${sequence}`,
    type: 'system',
    sequence,
    createdAt: new Date(0),
    content: { subtype, tool_use_id: toolUseId },
  };
}

describe('toolUseBlocks', () => {
  it('yields every identified tool_use block with its message, in transcript order', () => {
    const messages = [
      assistant(1, [{ type: 'text', text: 'hi' }, toolUse('a', 'Read')]),
      {
        id: 'u',
        type: 'user',
        sequence: 2,
        createdAt: new Date(0),
        content: { message: { content: [toolUse('x', 'Nope')] } },
      },
      assistant(3, [toolUse('b', 'Bash'), toolUse('c', 'Grep')], 'parent-1'),
    ];
    const seen = [...toolUseBlocks(messages)].map(({ block, message }) => [
      block.id,
      message.sequence,
    ]);
    expect(seen).toEqual([
      ['a', 1],
      ['b', 3],
      ['c', 3],
    ]);
  });

  it('skips tool_use blocks without an id and assistant messages with non-array content', () => {
    const messages: DisplayMessage[] = [
      assistant(1, [{ type: 'tool_use', name: 'Read' }]),
      {
        id: 'm2',
        type: 'assistant',
        sequence: 2,
        createdAt: new Date(0),
        content: { message: { content: 'text' } },
      },
      { id: 'm3', type: 'assistant', sequence: 3, createdAt: new Date(0), content: undefined },
    ];
    expect([...toolUseBlocks(messages)]).toEqual([]);
  });
});

describe('buildToolResultMap', () => {
  it('keeps the server summary of an elided result and leaves its text to fetch', () => {
    const summary = summarizeToolResult('a\nb\n');
    const { resultMap } = buildToolResultMap([
      assistant(1, [toolUse('a', 'Glob')]),
      toolResultMessage(2, [{ type: 'tool_result', tool_use_id: 'a', is_error: true, summary }]),
    ]);
    expect(resultMap.get('a')).toEqual({ messageId: 'm2', is_error: true, summary });
  });

  it('summarizes an inline result whose summary is malformed', () => {
    const { resultMap } = buildToolResultMap([
      assistant(1, [toolUse('a', 'Glob')]),
      toolResultMessage(2, [
        { type: 'tool_result', tool_use_id: 'a', content: 'x\ny', summary: { bogus: 1 } },
      ]),
    ]);
    expect(resultMap.get('a')).toEqual({ ...inlineResult('x\ny'), messageId: 'm2' });
  });

  it('pairs results with their calls and records the result sequence', () => {
    const { resultMap, resultSequenceByToolUseId } = buildToolResultMap([
      assistant(1, [toolUse('a', 'Read'), toolUse('b', 'Bash')]),
      toolResultMessage(2, [toolResult('a', 'file contents')]),
      toolResultMessage(3, [toolResult('b', 'boom', true)]),
    ]);
    expect(resultMap.get('a')).toEqual({ ...inlineResult('file contents'), messageId: 'm2' });
    expect(resultMap.get('b')).toEqual({ ...inlineResult('boom', true), messageId: 'm3' });
    expect(resultSequenceByToolUseId.get('a')).toBe(2);
    expect(resultSequenceByToolUseId.get('b')).toBe(3);
  });

  it('pairs results from subagent calls too', () => {
    const { resultMap } = buildToolResultMap([
      assistant(1, [toolUse('child', 'Read')], 'parent-1'),
      toolResultMessage(2, [toolResult('child', 'x')]),
    ]);
    expect(resultMap.has('child')).toBe(true);
  });

  it('pairs a result whose tool_use appears later in the transcript', () => {
    const { resultMap } = buildToolResultMap([
      toolResultMessage(1, [toolResult('late', 'x')]),
      assistant(2, [toolUse('late', 'Read')]),
    ]);
    expect(resultMap.has('late')).toBe(true);
  });

  it('leaves out a result whose call is not loaded', () => {
    const { resultMap } = buildToolResultMap([
      assistant(1, [toolUse('a', 'Read')]),
      toolResultMessage(2, [toolResult('a', 'ok'), toolResult('orphan', 'lost')]),
    ]);
    expect(resultMap.has('a')).toBe(true);
    expect(resultMap.has('orphan')).toBe(false);
  });

  it('flattens array result content so MCP and ToolSearch calls show as finished', () => {
    const { resultMap } = buildToolResultMap([
      assistant(1, [toolUse('mcp', 'mcp__x__y'), toolUse('search', 'ToolSearch')]),
      toolResultMessage(2, [
        {
          type: 'tool_result',
          tool_use_id: 'mcp',
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
        {
          type: 'tool_result',
          tool_use_id: 'search',
          content: [{ type: 'tool_reference', tool_name: 'mcp__x__y' }],
        },
      ]),
    ]);
    expect(resultMap.get('mcp')?.text).toBe('first\n\nsecond');
    expect(resultMap.get('search')?.text).toBe('Loaded mcp__x__y');
  });

  it('stores empty content for a result with no content', () => {
    const { resultMap } = buildToolResultMap([
      assistant(1, [toolUse('a', 'Bash')]),
      toolResultMessage(2, [toolResult('a')]),
    ]);
    expect(resultMap.get('a')).toEqual({ ...inlineResult(''), messageId: 'm2' });
  });

  it('ignores user messages that are not tool results', () => {
    const { resultMap } = buildToolResultMap([
      {
        id: 'p',
        type: 'user',
        sequence: 1,
        createdAt: new Date(0),
        content: { message: { content: [{ type: 'text', text: 'hi' }] } },
      },
    ]);
    expect(resultMap.size).toBe(0);
  });
});

describe('collectSubagentLifecycles', () => {
  const agentCall = (seq: number, id: string, parent: string | null = null) =>
    assistant(seq, [toolUse(id, 'Agent', { description: 'x' })], parent);

  it('records the spawn, background marker, notification, result, and last child', () => {
    // Children deliberately out of order: lastChildSequence must not assume it.
    const children = new Map([
      ['agent-1', [assistant(6, [], 'agent-1'), assistant(4, [], 'agent-1')]],
    ]);
    const { lifecycles, agentBlockById } = collectSubagentLifecycles(
      [
        agentCall(1, 'agent-1'),
        system(2, 'task_started', 'agent-1'),
        system(7, 'task_notification', 'agent-1'),
        system(8, 'task_notification', 'agent-1'),
      ],
      children,
      new Map([['agent-1', 3]])
    );
    expect(lifecycles).toEqual([
      {
        toolUseId: 'agent-1',
        spawnSequence: 1,
        isBackground: true,
        notificationSequence: 7,
        lastChildSequence: 6,
        resultSequence: 3,
      },
    ]);
    expect(agentBlockById.get('agent-1')?.name).toBe('Agent');
  });

  it('treats a foreground subagent with no children as unresolved lifecycle fields', () => {
    const { lifecycles } = collectSubagentLifecycles(
      [assistant(1, [toolUse('task-1', 'Task')])],
      new Map(),
      new Map()
    );
    expect(lifecycles).toEqual([
      {
        toolUseId: 'task-1',
        spawnSequence: 1,
        isBackground: false,
        notificationSequence: null,
        lastChildSequence: null,
        resultSequence: null,
      },
    ]);
  });

  it('ignores nested subagent calls and non-Agent tools, preserving spawn order', () => {
    const { lifecycles, agentBlockById } = collectSubagentLifecycles(
      [
        agentCall(5, 'agent-b'),
        assistant(6, [toolUse('read', 'Read')]),
        agentCall(7, 'nested', 'agent-b'),
        agentCall(9, 'agent-a'),
      ],
      new Map(),
      new Map()
    );
    expect(lifecycles.map((l) => l.toolUseId)).toEqual(['agent-b', 'agent-a']);
    expect([...agentBlockById.keys()]).toEqual(['agent-b', 'agent-a']);
  });

  it('ignores system task messages without a tool_use_id', () => {
    const { lifecycles } = collectSubagentLifecycles(
      [agentCall(1, 'agent-1'), system(2, 'task_started')],
      new Map(),
      new Map()
    );
    expect(lifecycles[0].isBackground).toBe(false);
  });
});

describe('getLatestTodoWriteId', () => {
  it('returns the last TodoWrite id, including when several sit in one message', () => {
    expect(
      getLatestTodoWriteId([
        assistant(1, [toolUse('todo-1', 'TodoWrite')]),
        assistant(2, [toolUse('todo-2', 'TodoWrite'), toolUse('todo-3', 'TodoWrite')]),
        assistant(3, [toolUse('read', 'Read')]),
      ])
    ).toBe('todo-3');
  });

  it('returns null when there is no TodoWrite', () => {
    expect(getLatestTodoWriteId([assistant(1, [toolUse('read', 'Read')])])).toBeNull();
    expect(
      getLatestTodoWriteId([assistant(1, [{ type: 'tool_use', name: 'TodoWrite' }])])
    ).toBeNull();
    expect(getLatestTodoWriteId([])).toBeNull();
  });
});

describe('getPlanContentByToolUseId', () => {
  const PLAN = '/home/u/.claude/plans/feature.md';

  it('replays plan-file writes and edits into each ExitPlanMode', () => {
    const plans = getPlanContentByToolUseId([
      assistant(1, [toolUse('w', 'Write', { file_path: PLAN, content: '# Plan\nstep one' })]),
      assistant(2, [
        toolUse('e', 'Edit', { file_path: PLAN, old_string: 'step one', new_string: 'step two' }),
      ]),
      assistant(3, [toolUse('exit-1', 'ExitPlanMode', {})]),
      assistant(4, [toolUse('w2', 'Write', { file_path: '/repo/src/index.ts', content: 'code' })]),
      assistant(5, [toolUse('w3', 'Write', { file_path: PLAN, content: 'rewritten' })]),
      assistant(6, [toolUse('exit-2', 'ExitPlanMode', {})]),
    ]);
    expect(plans.get('exit-1')).toBe('# Plan\nstep two');
    expect(plans.get('exit-2')).toBe('rewritten');
  });

  it('tolerates missing or malformed tool input', () => {
    const plans = getPlanContentByToolUseId([
      assistant(1, [{ type: 'tool_use', id: 'w', name: 'Write' }]),
      assistant(2, [toolUse('e', 'Edit', { file_path: 42 })]),
      assistant(3, [toolUse('w2', 'Write', { file_path: PLAN, content: 'ok' })]),
      assistant(4, [toolUse('exit-1', 'ExitPlanMode', {})]),
    ]);
    expect([...plans]).toEqual([['exit-1', 'ok']]);
  });
});

describe('buildTranscriptLayout', () => {
  const text = (t: string): ContentBlock => ({ type: 'text', text: t });
  const rowKeys = (layout: ReturnType<typeof buildTranscriptLayout>) =>
    layout.rows.map((row) =>
      row.kind === 'message' ? row.message.id : `box:${row.toolUseId}@${row.sequence}`
    );

  // A background subagent spawned at 1, with main-agent output interleaved at 5.
  const backgroundSubagent = [
    assistant(1, [toolUse('agent-1', 'Agent', { description: 'x' })]),
    system(2, 'task_started', 'agent-1'),
    toolResultMessage(3, [toolResult('agent-1', 'launched')]),
    assistant(4, [text('child work')], 'agent-1'),
    assistant(5, [text('main work')]),
  ];

  it('merges a finished relocated box into the rows at its finish sequence', () => {
    const layout = buildTranscriptLayout(
      [
        ...backgroundSubagent,
        system(7, 'task_notification', 'agent-1'),
        assistant(8, [text('after')]),
      ],
      true
    );
    // Hidden system rows, the paired ack, and the subagent's child stay out of the rows.
    expect(rowKeys(layout)).toEqual(['m1', 'm5', 'box:agent-1@7', 'm8']);
    expect(layout.pinnedSubagents).toEqual([]);
    expect([...layout.relocatedSubagentIds]).toEqual(['agent-1']);
    expect(layout.subagentMessagesByToolUseId.get('agent-1')?.map((m) => m.id)).toEqual(['m4']);
    const box = layout.rows[2];
    expect(box.kind === 'taskbox' && box.tool).toMatchObject({
      id: 'agent-1',
      result: { text: 'launched' },
    });
  });

  it('pins a running subagent below the rows instead of merging it', () => {
    const layout = buildTranscriptLayout(backgroundSubagent, true);
    expect(rowKeys(layout)).toEqual(['m1', 'm5']);
    expect(layout.pinnedSubagents.map((p) => [p.toolUseId, p.tool.name])).toEqual([
      ['agent-1', 'Agent'],
    ]);
    expect([...layout.relocatedSubagentIds]).toEqual(['agent-1']);
  });

  it('settles an unfinished background subagent once the session stops', () => {
    const layout = buildTranscriptLayout(
      [...backgroundSubagent, assistant(6, [text('more child work')], 'agent-1')],
      false
    );
    expect(rowKeys(layout)).toEqual(['m1', 'm5', 'box:agent-1@6']);
    expect(layout.pinnedSubagents).toEqual([]);
  });

  it('orders several relocated and pinned boxes', () => {
    const spawn = (seq: number, id: string) => [
      assistant(seq, [toolUse(id, 'Agent', { description: id })]),
      system(seq + 1, 'task_started', id),
    ];
    const messages = [
      ...spawn(1, 'a'),
      ...spawn(3, 'b'),
      ...spawn(5, 'c'),
      ...spawn(7, 'd'),
      assistant(9, [text('main work')]),
      // b finishes before a; c and d are still running.
      system(10, 'task_notification', 'b'),
      system(11, 'task_notification', 'a'),
    ];
    const layout = buildTranscriptLayout(messages, true);
    expect(rowKeys(layout)).toEqual(['m1', 'm3', 'm5', 'm7', 'm9', 'box:b@10', 'box:a@11']);
    expect(layout.pinnedSubagents.map((p) => p.toolUseId)).toEqual(['c', 'd']);
  });

  it('keeps a subagent inline when nothing interleaves', () => {
    const layout = buildTranscriptLayout(
      [
        assistant(1, [toolUse('task-1', 'Task')]),
        toolResultMessage(2, [toolResult('task-1', 'ok')]),
      ],
      true
    );
    expect(rowKeys(layout)).toEqual(['m1']);
    expect(layout.relocatedSubagentIds.size).toBe(0);
  });
});

describe('collectRetractedMessages', () => {
  const withUuid = (message: DisplayMessage, uuid: string): DisplayMessage => ({
    ...message,
    content: { ...(message.content as object), uuid },
  });
  const fallback = (sequence: number, retracted: unknown): DisplayMessage => ({
    id: `m${sequence}`,
    type: 'system',
    sequence,
    createdAt: new Date(0),
    content: { subtype: 'model_refusal_fallback', retracted_message_uuids: retracted },
  });
  const ids = (map: Map<string, DisplayMessage[]>) =>
    Object.fromEntries([...map].map(([key, messages]) => [key, messages.map((m) => m.id)]));

  it('groups retracted messages under their fallback in transcript order', () => {
    const map = collectRetractedMessages([
      withUuid(assistant(1, [{ type: 'text', text: 'kept' }]), 'u1'),
      withUuid(assistant(2, [{ type: 'text', text: 'a' }]), 'u2'),
      withUuid(toolResultMessage(3, [toolResult('x', 'r')]), 'u3'),
      withUuid(assistant(4, [{ type: 'text', text: 'redo' }]), 'u4'),
      fallback(5, ['u3', 'u2']),
    ]);
    expect(ids(map)).toEqual({ m5: ['m2', 'm3'] });
  });

  it('keys each retraction to its own fallback', () => {
    const map = collectRetractedMessages([
      withUuid(assistant(1, []), 'u1'),
      fallback(2, ['u1']),
      withUuid(assistant(3, []), 'u3'),
      fallback(4, ['u3']),
    ]);
    expect(ids(map)).toEqual({ m2: ['m1'], m4: ['m3'] });
  });

  it('folds only the loaded part of a partial retraction', () => {
    const map = collectRetractedMessages([
      withUuid(assistant(2, []), 'u2'),
      fallback(3, ['u1', 'u2']),
    ]);
    expect(ids(map)).toEqual({ m3: ['m2'] });
  });

  it('leaves a retracted subagent spawn in place, since its subagent still ran', () => {
    const map = collectRetractedMessages([
      withUuid(assistant(1, [toolUse('agent-1', 'Agent')]), 'u1'),
      withUuid(assistant(2, [{ type: 'text', text: 'a' }]), 'u2'),
      fallback(3, ['u1', 'u2']),
    ]);
    expect(ids(map)).toEqual({ m3: ['m2'] });
  });

  it('ignores fallbacks without a usable uuid list', () => {
    const map = collectRetractedMessages([
      withUuid(assistant(1, []), 'u1'),
      fallback(2, undefined),
      fallback(3, 'u1'),
      fallback(4, [42]),
    ]);
    expect(map.size).toBe(0);
  });
});

describe('buildTranscriptLayout retraction', () => {
  it('removes retracted messages from the rows and keeps their paired results inline', () => {
    const withUuid = (message: DisplayMessage, uuid: string): DisplayMessage => ({
      ...message,
      content: { ...(message.content as object), uuid },
    });
    const layout = buildTranscriptLayout(
      [
        withUuid(assistant(1, [toolUse('t1', 'Bash')]), 'u1'),
        withUuid(toolResultMessage(2, [toolResult('t1', 'out')]), 'u2'),
        withUuid(assistant(3, [toolUse('t2', 'Bash')]), 'u3'),
        {
          id: 'm4',
          type: 'system',
          sequence: 4,
          createdAt: new Date(0),
          content: { subtype: 'model_refusal_fallback', retracted_message_uuids: ['u1', 'u2'] },
        },
      ],
      true
    );
    expect(layout.rows.map((row) => row.kind === 'message' && row.message.id)).toEqual([
      'm3',
      'm4',
    ]);
    expect(layout.retractedMessagesByFallbackId.get('m4')?.map((m) => m.id)).toEqual(['m1']);
    expect(layout.resultMap.get('t1')?.text).toBe('out');
  });

  it('folds nothing when the retracted messages have nothing to render', () => {
    // The common prod shape: the retracted turn was only empty thinking blocks.
    const layout = buildTranscriptLayout(
      [
        {
          ...assistant(1, [{ type: 'thinking', thinking: '' }]),
          content: { uuid: 'u1', message: { content: [{ type: 'thinking', thinking: '' }] } },
        },
        {
          id: 'm2',
          type: 'system',
          sequence: 2,
          createdAt: new Date(0),
          content: { subtype: 'model_refusal_fallback', retracted_message_uuids: ['u1'] },
        },
      ],
      true
    );
    expect(layout.retractedMessagesByFallbackId.size).toBe(0);
  });
});
