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
  hasRenderableAssistantContent,
  isHiddenSystemMessage,
  isToolCallOnlyMessage,
  isVisibleTranscriptMessage,
  getParentToolUseId,
  groupSubagentMessages,
  computeSubagentPlacements,
  toolUseBlocks,
  buildToolResultMap,
  collectSubagentLifecycles,
  getLatestTodoWriteId,
  getPendingAskUserQuestions,
  getPlanContentByToolUseId,
  type SubagentLifecycle,
} from './messageHelpers';
import type { ContentBlock, DisplayMessage, ToolResultMap } from './types';

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

  it('returns true for a server_tool_use block (e.g. the advisor tool)', () => {
    expect(
      hasRenderableAssistantContent({
        message: {
          content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} }],
        },
      })
    ).toBe(true);
  });

  it('returns false when the only block is an advisor_tool_result (encrypted, nothing to show)', () => {
    expect(
      hasRenderableAssistantContent({
        message: {
          content: [
            {
              type: 'advisor_tool_result',
              tool_use_id: 'srvtoolu_1',
              content: { type: 'advisor_redacted_result', encrypted_content: 'abc' },
            },
          ],
        },
      })
    ).toBe(false);
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

describe('isHiddenSystemMessage', () => {
  it('hides generic system subtypes, init banners, and hooks', () => {
    for (const subtype of [
      'init',
      'hook_started',
      'hook_response',
      'notification',
      'task_started',
    ]) {
      expect(isHiddenSystemMessage('system', { subtype } as MessageContent)).toBe(true);
    }
    // A system message with no subtype at all is also hidden.
    expect(isHiddenSystemMessage('system', {} as MessageContent)).toBe(true);
  });

  it('keeps errors, compact boundaries, and refusal fallbacks visible', () => {
    expect(isHiddenSystemMessage('system', { subtype: 'error' } as MessageContent)).toBe(false);
    expect(isHiddenSystemMessage('system', { subtype: 'compact_boundary' } as MessageContent)).toBe(
      false
    );
    expect(
      isHiddenSystemMessage('system', { subtype: 'model_refusal_fallback' } as MessageContent)
    ).toBe(false);
  });

  it('never hides non-system messages', () => {
    expect(isHiddenSystemMessage('assistant', { subtype: 'init' } as MessageContent)).toBe(false);
    expect(isHiddenSystemMessage('user', {} as MessageContent)).toBe(false);
    expect(isHiddenSystemMessage('result', { subtype: 'success' } as MessageContent)).toBe(false);
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

describe('isVisibleTranscriptMessage', () => {
  const message = (over: Partial<DisplayMessage>): DisplayMessage => ({
    id: 'm1',
    type: 'assistant',
    sequence: 0,
    content: { message: { content: [{ type: 'text', text: 'hi' }] } },
    ...over,
  });

  it('shows a normal assistant message', () => {
    expect(isVisibleTranscriptMessage(message({}), new Set())).toBe(true);
  });

  it('hides messages whose id is in the paired set', () => {
    expect(isVisibleTranscriptMessage(message({ id: 'paired' }), new Set(['paired']))).toBe(false);
  });

  it('hides system messages except errors and compact boundaries', () => {
    expect(
      isVisibleTranscriptMessage(
        message({ type: 'system', content: { subtype: 'init' } }),
        new Set()
      )
    ).toBe(false);
    expect(
      isVisibleTranscriptMessage(
        message({ type: 'system', content: { subtype: 'error' } }),
        new Set()
      )
    ).toBe(true);
  });

  it('hides empty assistant fragments', () => {
    expect(
      isVisibleTranscriptMessage(
        message({ content: { message: { content: [{ type: 'thinking', thinking: '' }] } } }),
        new Set()
      )
    ).toBe(false);
  });
});

describe('getParentToolUseId', () => {
  it('returns the parent id for a subagent message', () => {
    expect(getParentToolUseId({ parent_tool_use_id: 'task-1' })).toBe('task-1');
  });

  it('returns null for top-level messages and non-objects', () => {
    expect(getParentToolUseId({ parent_tool_use_id: null })).toBeNull();
    expect(getParentToolUseId({})).toBeNull();
    expect(getParentToolUseId(undefined)).toBeNull();
    expect(getParentToolUseId('string')).toBeNull();
  });
});

describe('groupSubagentMessages', () => {
  const msg = (id: string, parent: string | null): DisplayMessage => ({
    id,
    type: 'assistant',
    sequence: 0,
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
      { id: 'm2', type: 'assistant', sequence: 2, content: { message: { content: 'text' } } },
      { id: 'm3', type: 'assistant', sequence: 3, content: undefined },
    ];
    expect([...toolUseBlocks(messages)]).toEqual([]);
  });
});

describe('buildToolResultMap', () => {
  it('pairs results with their calls and records the result sequence', () => {
    const { resultMap, pairedMessageIds, resultSequenceByToolUseId } = buildToolResultMap([
      assistant(1, [toolUse('a', 'Read'), toolUse('b', 'Bash')]),
      toolResultMessage(2, [toolResult('a', 'file contents')]),
      toolResultMessage(3, [toolResult('b', 'boom', true)]),
    ]);
    expect(resultMap.get('a')).toEqual({ content: 'file contents', is_error: undefined });
    expect(resultMap.get('b')).toEqual({ content: 'boom', is_error: true });
    expect([...pairedMessageIds]).toEqual(['m2', 'm3']);
    expect(resultSequenceByToolUseId.get('a')).toBe(2);
    expect(resultSequenceByToolUseId.get('b')).toBe(3);
  });

  it('pairs results from subagent calls too', () => {
    const { resultMap, pairedMessageIds } = buildToolResultMap([
      assistant(1, [toolUse('child', 'Read')], 'parent-1'),
      toolResultMessage(2, [toolResult('child', 'x')]),
    ]);
    expect(resultMap.has('child')).toBe(true);
    expect(pairedMessageIds.has('m2')).toBe(true);
  });

  it('pairs a result whose tool_use appears later in the transcript', () => {
    const { resultMap, pairedMessageIds } = buildToolResultMap([
      toolResultMessage(1, [toolResult('late', 'x')]),
      assistant(2, [toolUse('late', 'Read')]),
    ]);
    expect(resultMap.has('late')).toBe(true);
    expect(pairedMessageIds.has('m1')).toBe(true);
  });

  it('leaves a message unpaired when any of its results has no matching call', () => {
    const { resultMap, pairedMessageIds } = buildToolResultMap([
      assistant(1, [toolUse('a', 'Read')]),
      toolResultMessage(2, [toolResult('a', 'ok'), toolResult('orphan', 'lost')]),
    ]);
    expect(resultMap.has('a')).toBe(true);
    expect(resultMap.has('orphan')).toBe(false);
    expect(pairedMessageIds.size).toBe(0);
  });

  it('stores undefined content for non-string result content', () => {
    const { resultMap } = buildToolResultMap([
      assistant(1, [toolUse('a', 'Agent')]),
      toolResultMessage(2, [{ type: 'tool_result', tool_use_id: 'a', content: { type: 'text' } }]),
    ]);
    expect(resultMap.get('a')).toEqual({ content: undefined, is_error: undefined });
  });

  it('ignores user messages that are not tool results', () => {
    const { pairedMessageIds } = buildToolResultMap([
      {
        id: 'p',
        type: 'user',
        sequence: 1,
        content: { message: { content: [{ type: 'text', text: 'hi' }] } },
      },
    ]);
    expect(pairedMessageIds.size).toBe(0);
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

describe('getPendingAskUserQuestions', () => {
  const ask = (id: string, questions?: unknown) => toolUse(id, 'AskUserQuestion', { questions });

  it('returns questions without a result, in order, with the first question summarized', () => {
    const resultMap: ToolResultMap = new Map([['q-answered', { content: 'yes' }]]);
    expect(
      getPendingAskUserQuestions(
        [
          assistant(1, [ask('q-answered', [{ header: 'Old', question: 'Done?' }])]),
          assistant(2, [
            ask('q-1', [
              { header: 'Approach', question: 'Which one?' },
              { header: 'Ignored', question: 'Second' },
            ]),
          ]),
          assistant(3, [ask('q-2'), toolUse('read', 'Read')]),
        ],
        resultMap
      )
    ).toEqual([
      { id: 'q-1', header: 'Approach', question: 'Which one?' },
      { id: 'q-2', header: 'Question', question: 'Claude needs your input' },
    ]);
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
