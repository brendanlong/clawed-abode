import { describe, it, expect } from 'vitest';
import {
  extractAssistantText,
  getNewAutoReadMessages,
  type AutoReadMessage,
} from './auto-read-helpers';

/** Helper to create an assistant message with text blocks */
function makeAssistantText(id: string, sequence: number, text: string): AutoReadMessage {
  return {
    id,
    type: 'assistant',
    sequence,
    content: {
      message: {
        content: [{ type: 'text', text }],
      },
    },
  };
}

/** Helper to create an assistant message with only tool_use blocks */
function makeAssistantToolUse(id: string, sequence: number): AutoReadMessage {
  return {
    id,
    type: 'assistant',
    sequence,
    content: {
      message: {
        content: [{ type: 'tool_use', id: `tool-${id}`, name: 'Bash', input: { command: 'ls' } }],
      },
    },
  };
}

/** Helper to create an assistant message with both text and tool_use blocks */
function makeAssistantMixed(id: string, sequence: number, text: string): AutoReadMessage {
  return {
    id,
    type: 'assistant',
    sequence,
    content: {
      message: {
        content: [
          { type: 'text', text },
          { type: 'tool_use', id: `tool-${id}`, name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
  };
}

/** Helper to create a user-sent prompt message */
function makeUserPrompt(id: string, sequence: number, text: string): AutoReadMessage {
  return {
    id,
    type: 'user',
    sequence,
    content: {
      message: {
        content: [{ type: 'text', text }],
      },
    },
  };
}

/** Helper to create a tool result message (type: user, but with tool_result blocks) */
function makeToolResult(id: string, sequence: number): AutoReadMessage {
  return {
    id,
    type: 'user',
    sequence,
    content: {
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: `tool-${id}`,
            content: 'output here',
          },
        ],
      },
    },
  };
}

/** Helper to create a partial (streaming) assistant message */
function makePartialAssistant(text: string, sequence: number): AutoReadMessage {
  return {
    id: `partial-${crypto.randomUUID()}`,
    type: 'assistant',
    sequence,
    content: {
      message: {
        content: [{ type: 'text', text }],
      },
    },
  };
}

/** Helper to create a result message */
function makeResult(id: string, sequence: number): AutoReadMessage {
  return {
    id,
    type: 'result',
    sequence,
    content: { subtype: 'result', cost_usd: 0.01 },
  };
}

describe('extractAssistantText', () => {
  it('extracts text from a message with text blocks', () => {
    const msg = makeAssistantText('a1', 1, 'Hello world');
    expect(extractAssistantText(msg)).toBe('Hello world');
  });

  it('concatenates multiple text blocks', () => {
    const msg: AutoReadMessage = {
      id: 'a1',
      type: 'assistant',
      sequence: 1,
      content: {
        message: {
          content: [
            { type: 'text', text: 'First part' },
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} },
            { type: 'text', text: 'Second part' },
          ],
        },
      },
    };
    expect(extractAssistantText(msg)).toBe('First part\nSecond part');
  });

  it('returns null for tool-use-only messages', () => {
    const msg = makeAssistantToolUse('a1', 1);
    expect(extractAssistantText(msg)).toBeNull();
  });

  it('returns null for messages with only whitespace text', () => {
    const msg = makeAssistantText('a1', 1, '   \n  ');
    expect(extractAssistantText(msg)).toBeNull();
  });

  it('returns null for messages with no content blocks', () => {
    const msg: AutoReadMessage = {
      id: 'a1',
      type: 'assistant',
      sequence: 1,
      content: { message: { content: [] } },
    };
    expect(extractAssistantText(msg)).toBeNull();
  });

  it('returns null for malformed content', () => {
    const msg: AutoReadMessage = {
      id: 'a1',
      type: 'assistant',
      sequence: 1,
      content: {},
    };
    expect(extractAssistantText(msg)).toBeNull();
  });
});

describe('getNewAutoReadMessages', () => {
  it('returns empty array when no messages exist', () => {
    expect(getNewAutoReadMessages([], new Set())).toEqual([]);
  });

  it('returns new assistant text messages from the current turn', () => {
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Fix the bug'),
      makeAssistantText('a1', 2, 'I fixed the bug.'),
      makeResult('r1', 3),
    ];

    const result = getNewAutoReadMessages(messages, new Set());
    expect(result).toEqual([{ id: 'a1', text: 'I fixed the bug.' }]);
  });

  it('returns all text messages from the current turn (not just first and last)', () => {
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Do work'),
      makeAssistantText('a1', 2, 'Step 1.'),
      makeAssistantText('a2', 3, 'Step 2.'),
      makeAssistantText('a3', 4, 'Step 3.'),
      makeAssistantText('a4', 5, 'Step 4.'),
    ];

    const result = getNewAutoReadMessages(messages, new Set());
    expect(result).toEqual([
      { id: 'a1', text: 'Step 1.' },
      { id: 'a2', text: 'Step 2.' },
      { id: 'a3', text: 'Step 3.' },
      { id: 'a4', text: 'Step 4.' },
    ]);
  });

  it('skips messages that are already queued', () => {
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Fix the bug'),
      makeAssistantText('a1', 2, 'Let me look at the code.'),
      makeAssistantToolUse('a2', 3),
      makeToolResult('tr1', 4),
      makeAssistantText('a3', 5, 'I see the issue.'),
      makeAssistantToolUse('a4', 6),
      makeToolResult('tr2', 7),
      makeAssistantText('a5', 8, 'Done! I fixed the bug.'),
    ];

    // a1 and a3 already queued
    const queuedIds = new Set(['a1', 'a3']);
    const result = getNewAutoReadMessages(messages, queuedIds);
    expect(result).toEqual([{ id: 'a5', text: 'Done! I fixed the bug.' }]);
  });

  it('returns empty array when all messages are already queued', () => {
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Hello'),
      makeAssistantText('a1', 2, 'Hi there!'),
    ];

    const result = getNewAutoReadMessages(messages, new Set(['a1']));
    expect(result).toEqual([]);
  });

  it('skips tool-use-only messages', () => {
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Run the tests'),
      makeAssistantToolUse('a1', 2),
      makeToolResult('tr1', 3),
      makeAssistantToolUse('a2', 4),
      makeToolResult('tr2', 5),
      makeResult('r1', 6),
    ];

    const result = getNewAutoReadMessages(messages, new Set());
    expect(result).toEqual([]);
  });

  it('skips partial messages', () => {
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Fix it'),
      makeAssistantText('a1', 2, 'Working on it.'),
      makePartialAssistant('Still typing...', 3),
    ];

    const result = getNewAutoReadMessages(messages, new Set());
    expect(result).toEqual([{ id: 'a1', text: 'Working on it.' }]);
  });

  it('only considers messages from the current turn (after last user prompt)', () => {
    const messages: AutoReadMessage[] = [
      // Previous turn
      makeUserPrompt('u1', 1, 'First question'),
      makeAssistantText('a1', 2, 'First answer.'),
      makeResult('r1', 3),
      // Current turn
      makeUserPrompt('u2', 4, 'Second question'),
      makeAssistantText('a2', 5, 'Starting work.'),
      makeAssistantToolUse('a3', 6),
      makeToolResult('tr1', 7),
      makeAssistantText('a4', 8, 'All done.'),
    ];

    const result = getNewAutoReadMessages(messages, new Set());
    expect(result).toEqual([
      { id: 'a2', text: 'Starting work.' },
      { id: 'a4', text: 'All done.' },
    ]);
  });

  it('treats tool result user messages as non-turn-boundary', () => {
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Do something'),
      makeAssistantText('a1', 2, 'Starting.'),
      makeAssistantToolUse('a2', 3),
      makeToolResult('tr1', 4), // This is a 'user' type but NOT a user prompt
      makeAssistantText('a3', 5, 'Finished.'),
      makeResult('r1', 6),
    ];

    const result = getNewAutoReadMessages(messages, new Set());
    expect(result).toEqual([
      { id: 'a1', text: 'Starting.' },
      { id: 'a3', text: 'Finished.' },
    ]);
  });

  it('handles mixed text and tool_use blocks (assistant message with both)', () => {
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Fix it'),
      makeAssistantMixed('a1', 2, 'Let me run a command.'),
      makeToolResult('tr1', 3),
      makeAssistantMixed('a2', 4, 'All done!'),
    ];

    const result = getNewAutoReadMessages(messages, new Set());
    expect(result).toEqual([
      { id: 'a1', text: 'Let me run a command.' },
      { id: 'a2', text: 'All done!' },
    ]);
  });

  it('handles messages with no user prompt at all (edge case)', () => {
    const messages: AutoReadMessage[] = [
      makeAssistantText('a1', 1, 'Hello!'),
      makeAssistantToolUse('a2', 2),
      makeToolResult('tr1', 3),
      makeAssistantText('a3', 4, 'Done.'),
    ];

    const result = getNewAutoReadMessages(messages, new Set());
    expect(result).toEqual([
      { id: 'a1', text: 'Hello!' },
      { id: 'a3', text: 'Done.' },
    ]);
  });

  it('simulates incremental message arrival during a turn', () => {
    const queuedIds = new Set<string>();

    // First message arrives
    const messages1: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Fix the bug'),
      makeAssistantText('a1', 2, 'Let me look at the code.'),
    ];
    const result1 = getNewAutoReadMessages(messages1, queuedIds);
    expect(result1).toEqual([{ id: 'a1', text: 'Let me look at the code.' }]);
    // Simulate the caller adding to queuedIds
    for (const msg of result1) queuedIds.add(msg.id);

    // Tool use happens, no new text
    const messages2: AutoReadMessage[] = [
      ...messages1,
      makeAssistantToolUse('a2', 3),
      makeToolResult('tr1', 4),
    ];
    const result2 = getNewAutoReadMessages(messages2, queuedIds);
    expect(result2).toEqual([]);

    // New text message arrives
    const messages3: AutoReadMessage[] = [
      ...messages2,
      makeAssistantMixed('a3', 5, 'I see the issue, let me fix it.'),
    ];
    const result3 = getNewAutoReadMessages(messages3, queuedIds);
    expect(result3).toEqual([{ id: 'a3', text: 'I see the issue, let me fix it.' }]);
    for (const msg of result3) queuedIds.add(msg.id);

    // More tool use, then final message
    const messages4: AutoReadMessage[] = [
      ...messages3,
      makeAssistantToolUse('a4', 6),
      makeToolResult('tr2', 7),
      makeAssistantText('a5', 8, 'Done! I fixed the bug.'),
      makeResult('r1', 9),
    ];
    const result4 = getNewAutoReadMessages(messages4, queuedIds);
    expect(result4).toEqual([{ id: 'a5', text: 'Done! I fixed the bug.' }]);
  });

  it('returns empty when all current-turn messages already queued', () => {
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Fix it'),
      makeAssistantText('a1', 2, 'Working on it.'),
      makeAssistantText('a2', 3, 'Done.'),
    ];

    const result = getNewAutoReadMessages(messages, new Set(['a1', 'a2']));
    expect(result).toEqual([]);
  });

  it('ignores queued IDs from previous turns', () => {
    // If queuedIds contains IDs from a previous turn, they should be
    // irrelevant since those messages are before the turn boundary
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'First'),
      makeAssistantText('a1', 2, 'Response to first.'),
      makeUserPrompt('u2', 3, 'Second'),
      makeAssistantText('a2', 4, 'Response to second.'),
    ];

    // a1 is queued from previous turn but is before the turn boundary anyway
    const result = getNewAutoReadMessages(messages, new Set(['a1']));
    expect(result).toEqual([{ id: 'a2', text: 'Response to second.' }]);
  });
});
