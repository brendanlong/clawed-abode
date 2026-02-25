import { describe, it, expect } from 'vitest';
import {
  extractAssistantText,
  getAutoReadMessages,
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

describe('getAutoReadMessages', () => {
  it('returns empty array when no messages exist', () => {
    expect(getAutoReadMessages([])).toEqual([]);
  });

  it('returns single text message when only one assistant text message exists', () => {
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Fix the bug'),
      makeAssistantText('a1', 2, 'I fixed the bug.'),
      makeResult('r1', 3),
    ];

    const result = getAutoReadMessages(messages);
    expect(result).toEqual([{ id: 'a1', text: 'I fixed the bug.' }]);
  });

  it('returns first and last text messages when multiple exist with tool calls between', () => {
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Fix the bug'),
      makeAssistantText('a1', 2, 'Let me look at the code.'),
      makeAssistantToolUse('a2', 3),
      makeToolResult('tr1', 4),
      makeAssistantMixed('a3', 5, 'I see the issue, let me fix it.'),
      makeAssistantToolUse('a4', 6),
      makeToolResult('tr2', 7),
      makeAssistantText('a5', 8, 'Done! I fixed the bug.'),
      makeResult('r1', 9),
    ];

    const result = getAutoReadMessages(messages);
    expect(result).toEqual([
      { id: 'a1', text: 'Let me look at the code.' },
      { id: 'a5', text: 'Done! I fixed the bug.' },
    ]);
  });

  it('returns empty array when only tool-use messages exist', () => {
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Run the tests'),
      makeAssistantToolUse('a1', 2),
      makeToolResult('tr1', 3),
      makeAssistantToolUse('a2', 4),
      makeToolResult('tr2', 5),
      makeResult('r1', 6),
    ];

    const result = getAutoReadMessages(messages);
    expect(result).toEqual([]);
  });

  it('deduplicates when first and last are the same message', () => {
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Hello'),
      makeAssistantText('a1', 2, 'Hi there!'),
    ];

    const result = getAutoReadMessages(messages);
    expect(result).toEqual([{ id: 'a1', text: 'Hi there!' }]);
    expect(result).toHaveLength(1);
  });

  it('skips partial messages', () => {
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Fix it'),
      makeAssistantText('a1', 2, 'Working on it.'),
      makePartialAssistant('Still typing...', 3),
    ];

    const result = getAutoReadMessages(messages);
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
      makeResult('r2', 9),
    ];

    const result = getAutoReadMessages(messages);
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

    const result = getAutoReadMessages(messages);
    // Should see both messages from this turn since tool result is not a turn boundary
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

    const result = getAutoReadMessages(messages);
    expect(result).toEqual([
      { id: 'a1', text: 'Let me run a command.' },
      { id: 'a2', text: 'All done!' },
    ]);
  });

  it('returns all middle text messages skipped (only first and last)', () => {
    const messages: AutoReadMessage[] = [
      makeUserPrompt('u1', 1, 'Do work'),
      makeAssistantText('a1', 2, 'Step 1.'),
      makeAssistantText('a2', 3, 'Step 2.'),
      makeAssistantText('a3', 4, 'Step 3.'),
      makeAssistantText('a4', 5, 'Step 4.'),
    ];

    const result = getAutoReadMessages(messages);
    expect(result).toEqual([
      { id: 'a1', text: 'Step 1.' },
      { id: 'a4', text: 'Step 4.' },
    ]);
  });

  it('handles messages with no user prompt at all (edge case)', () => {
    // This could happen if the session starts with an initial prompt sent server-side
    // and we only see the assistant responses
    const messages: AutoReadMessage[] = [
      makeAssistantText('a1', 1, 'Hello!'),
      makeAssistantToolUse('a2', 2),
      makeToolResult('tr1', 3),
      makeAssistantText('a3', 4, 'Done.'),
    ];

    const result = getAutoReadMessages(messages);
    expect(result).toEqual([
      { id: 'a1', text: 'Hello!' },
      { id: 'a3', text: 'Done.' },
    ]);
  });
});
