import { describe, it, expect } from 'vitest';
import {
  autoReadStep,
  INITIAL_AUTO_READ_STATE,
  type AutoReadEvent,
  type AutoReadState,
  extractAssistantText,
  getAssistantTextMessages,
  getNewAutoReadMessages,
} from './playable-messages';
import type { DisplayMessage } from '@/components/messages/types';

/** Helper to create an assistant message with text blocks */
function makeAssistantText(id: string, sequence: number, text: string): DisplayMessage {
  return {
    id,
    type: 'assistant',
    sequence,
    createdAt: new Date(0),
    content: {
      message: {
        content: [{ type: 'text', text }],
      },
    },
  };
}

/** Helper to create an assistant message with only tool_use blocks */
function makeAssistantToolUse(id: string, sequence: number): DisplayMessage {
  return {
    id,
    type: 'assistant',
    sequence,
    createdAt: new Date(0),
    content: {
      message: {
        content: [{ type: 'tool_use', id: `tool-${id}`, name: 'Bash', input: { command: 'ls' } }],
      },
    },
  };
}

/** Helper to create an assistant message with both text and tool_use blocks */
function makeAssistantMixed(id: string, sequence: number, text: string): DisplayMessage {
  return {
    id,
    type: 'assistant',
    sequence,
    createdAt: new Date(0),
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
function makeUserPrompt(id: string, sequence: number, text: string): DisplayMessage {
  return {
    id,
    type: 'user',
    sequence,
    createdAt: new Date(0),
    content: {
      message: {
        content: [{ type: 'text', text }],
      },
    },
  };
}

/** Helper to create a tool result message (type: user, but with tool_result blocks) */
function makeToolResult(id: string, sequence: number): DisplayMessage {
  return {
    id,
    type: 'user',
    sequence,
    createdAt: new Date(0),
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
function makePartialAssistant(text: string, sequence: number): DisplayMessage {
  return {
    id: `partial-${crypto.randomUUID()}`,
    type: 'assistant',
    sequence,
    createdAt: new Date(0),
    content: {
      message: {
        content: [{ type: 'text', text }],
      },
    },
  };
}

/** Helper to create a result message */
function makeResult(id: string, sequence: number): DisplayMessage {
  return {
    id,
    type: 'result',
    sequence,
    createdAt: new Date(0),
    content: { subtype: 'result', cost_usd: 0.01 },
  };
}

describe('extractAssistantText', () => {
  it('extracts text from a message with text blocks', () => {
    const msg = makeAssistantText('a1', 1, 'Hello world');
    expect(extractAssistantText(msg)).toBe('Hello world');
  });

  it('concatenates multiple text blocks', () => {
    const msg: DisplayMessage = {
      id: 'a1',
      type: 'assistant',
      sequence: 1,
      createdAt: new Date(0),
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
    const msg: DisplayMessage = {
      id: 'a1',
      type: 'assistant',
      sequence: 1,
      createdAt: new Date(0),
      content: { message: { content: [] } },
    };
    expect(extractAssistantText(msg)).toBeNull();
  });

  it('returns null for malformed content', () => {
    const msg: DisplayMessage = {
      id: 'a1',
      type: 'assistant',
      sequence: 1,
      createdAt: new Date(0),
      content: {},
    };
    expect(extractAssistantText(msg)).toBeNull();
  });
});

describe('getAssistantTextMessages', () => {
  it('lists every complete assistant message with text, across turns', () => {
    const messages: DisplayMessage[] = [
      makeUserPrompt('u1', 1, 'First'),
      makeAssistantText('a1', 2, 'Answer one.'),
      makeAssistantToolUse('a2', 3),
      makeToolResult('tr1', 4),
      makeUserPrompt('u2', 5, 'Second'),
      makeAssistantMixed('a3', 6, 'Answer two.'),
      makePartialAssistant('typing', 7),
      makeResult('r1', 8),
    ];
    expect(getAssistantTextMessages(messages)).toEqual([
      { id: 'a1', text: 'Answer one.' },
      { id: 'a3', text: 'Answer two.' },
    ]);
  });

  it('skips null or non-object content without throwing', () => {
    const messages: DisplayMessage[] = [
      { id: 'a1', type: 'assistant', sequence: 1, createdAt: new Date(0), content: null },
      { id: 'a2', type: 'assistant', sequence: 2, createdAt: new Date(0), content: 'plain string' },
      makeAssistantText('a3', 3, 'Real text.'),
    ];
    expect(getAssistantTextMessages(messages)).toEqual([{ id: 'a3', text: 'Real text.' }]);
  });
});

describe('getNewAutoReadMessages', () => {
  it('returns empty array when no messages exist', () => {
    expect(getNewAutoReadMessages([], new Set())).toEqual([]);
  });

  it('returns all text messages from the current turn (not just first and last)', () => {
    const messages: DisplayMessage[] = [
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
    const messages: DisplayMessage[] = [
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

  it('skips tool-use-only messages', () => {
    const messages: DisplayMessage[] = [
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
    const messages: DisplayMessage[] = [
      makeUserPrompt('u1', 1, 'Fix it'),
      makeAssistantText('a1', 2, 'Working on it.'),
      makePartialAssistant('Still typing...', 3),
    ];

    const result = getNewAutoReadMessages(messages, new Set());
    expect(result).toEqual([{ id: 'a1', text: 'Working on it.' }]);
  });

  it('only considers messages from the current turn (after last user prompt)', () => {
    const messages: DisplayMessage[] = [
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

  it('handles mixed text and tool_use blocks (assistant message with both)', () => {
    const messages: DisplayMessage[] = [
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
    const messages: DisplayMessage[] = [
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

  it('returns empty when all current-turn messages already queued', () => {
    const messages: DisplayMessage[] = [
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
    const messages: DisplayMessage[] = [
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

describe('autoReadStep', () => {
  function run(events: AutoReadEvent[], state: AutoReadState = INITIAL_AUTO_READ_STATE) {
    const enqueued: string[] = [];
    for (const event of events) {
      const result = autoReadStep(state, event);
      state = result.state;
      enqueued.push(...result.toEnqueue.map((m) => m.id));
    }
    return enqueued;
  }

  const update = (
    isRunning: boolean,
    messages: DisplayMessage[],
    enabled = true
  ): AutoReadEvent => ({
    type: 'update',
    isRunning,
    messages,
    enabled,
  });

  const turn1 = [makeUserPrompt('u1', 1, 'Go'), makeAssistantText('a1', 2, 'One.')];
  const turn1More = [...turn1, makeAssistantText('a2', 3, 'Two.')];

  it('enqueues each message once as a turn streams', () => {
    expect(run([update(true, turn1), update(true, turn1), update(true, turn1More)])).toEqual([
      'a1',
      'a2',
    ]);
  });

  it('catches messages arriving in the same update the turn ends', () => {
    expect(run([update(true, turn1), update(false, turn1More)])).toEqual(['a1', 'a2']);
  });

  it('enqueues nothing while idle or disabled', () => {
    expect(run([update(false, turn1)])).toEqual([]);
    expect(run([update(true, turn1, false), update(true, turn1More, false)])).toEqual([]);
  });

  it('stays quiet for the rest of the turn after the user stops playback', () => {
    expect(
      run([
        update(true, turn1),
        { type: 'playbackStopped' },
        update(true, turn1More),
        update(false, turn1More),
      ])
    ).toEqual(['a1']);
  });

  it('resumes on the next turn after a stop', () => {
    const turn2 = [
      ...turn1More,
      makeUserPrompt('u2', 4, 'Again'),
      makeAssistantText('a3', 5, 'Three.'),
    ];
    expect(
      run([
        update(true, turn1),
        { type: 'playbackStopped' },
        update(false, turn1More),
        update(true, turn2),
      ])
    ).toEqual(['a1', 'a3']);
  });

  it('keeps reading replies to a prompt sent mid-turn', () => {
    const reply = [
      ...turn1,
      makeUserPrompt('u2', 3, 'Also this'),
      makeAssistantText('a3', 4, 'Sure.'),
    ];
    expect(
      run([update(true, turn1), { type: 'promptSent', messages: turn1 }, update(true, reply)])
    ).toEqual(['a1', 'a3']);
  });

  it('keeps reading replies to a prompt sent mid-turn after the user stopped playback', () => {
    const afterSend = [...turn1More, makeUserPrompt('u2', 4, 'Also this')];
    const reply = [...afterSend, makeAssistantText('a3', 5, 'Sure.')];
    expect(
      run([
        update(true, turn1),
        { type: 'playbackStopped' },
        update(true, turn1More),
        { type: 'promptSent', messages: turn1More },
        update(true, afterSend),
        update(true, reply),
      ])
    ).toEqual(['a1', 'a3']);
  });

  it('skips what was on screen at send time, even before the prompt reaches the cache', () => {
    // a2 arrived while playback was stopped; sending must not start reading it now.
    expect(
      run([
        update(true, turn1),
        { type: 'playbackStopped' },
        update(true, turn1More),
        { type: 'promptSent', messages: turn1More },
        update(true, turn1More),
      ])
    ).toEqual(['a1']);
  });

  it("doesn't re-read the last turn when the running flag lands before the new prompt", () => {
    expect(
      run([update(true, turn1More), update(false, turn1More), update(true, turn1More)])
    ).toEqual(['a1', 'a2']);
  });
});
