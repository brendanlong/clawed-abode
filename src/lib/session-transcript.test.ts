import { describe, it, expect } from 'vitest';
import { fitNewestEntries, toTranscriptEntries, truncate } from './session-transcript';

const assistant = (content: unknown[], parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content },
});

const messages = [
  { sequence: 1, content: { type: 'user', content: 'Fix the bug' } },
  {
    sequence: 2,
    content: assistant([
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ]),
  },
  {
    sequence: 3,
    content: {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb' }] },
    },
  },
  { sequence: 4, content: assistant([{ type: 'text', text: 'subagent chatter' }], 't9') },
  { sequence: 5, content: { type: 'system', subtype: 'init', session_id: 'x' } },
  {
    sequence: 6,
    content: { type: 'system', subtype: 'error', content: [{ type: 'text', text: 'boom' }] },
  },
  { sequence: 7, content: { type: 'result', subtype: 'success', result: 'Done.' } },
  { sequence: 8, content: assistant([{ type: 'text', text: 'Done.' }]) },
];

describe('toTranscriptEntries', () => {
  it('keeps prompts, main-agent text, and errors, dropping tool traffic, subagents, and hidden system messages', () => {
    expect(toTranscriptEntries(messages, { includeToolCalls: false })).toEqual([
      { sequence: 1, role: 'user', text: 'Fix the bug' },
      { sequence: 2, role: 'assistant', text: 'Looking.' },
      { sequence: 6, role: 'error', text: 'boom' },
      { sequence: 8, role: 'assistant', text: 'Done.' },
    ]);
  });

  it('lists main-agent tool calls with their input when asked', () => {
    const entries = toTranscriptEntries(messages, { includeToolCalls: true });
    expect(entries).toContainEqual({
      sequence: 2,
      role: 'tool_call',
      text: 'Bash {"command":"ls"}',
    });
    expect(entries.filter((e) => e.role === 'tool_call')).toHaveLength(1);
  });
});

describe('fitNewestEntries', () => {
  const entries = [
    { sequence: 1, role: 'user' as const, text: 'hi' },
    { sequence: 2, role: 'assistant' as const, text: 'abcdef' },
    { sequence: 2, role: 'tool_call' as const, text: 'Bash {}' },
    { sequence: 3, role: 'assistant' as const, text: 'done' },
  ];

  it('labels each entry, caps its length, and reports a complete fit', () => {
    expect(fitNewestEntries(entries.slice(0, 2), 3, 1000)).toEqual({
      text: '[#1 user] hi\n\n[#2 assistant] abc… [truncated]',
      oldestSequence: 1,
      complete: true,
    });
  });

  it('keeps the newest whole messages within the budget', () => {
    // "[#3 assistant] done" is 19 chars; message 2 would push past 50.
    expect(fitNewestEntries(entries, 100, 50)).toEqual({
      text: '[#3 assistant] done',
      oldestSequence: 3,
      complete: false,
    });
    expect(fitNewestEntries(entries, 100, 80).oldestSequence).toBe(2);
  });

  it('always keeps the newest message, even over budget', () => {
    expect(fitNewestEntries(entries, 100, 1)).toMatchObject({ oldestSequence: 3 });
  });

  it('returns nothing for no entries', () => {
    expect(fitNewestEntries([], 100, 100)).toEqual({
      text: '',
      oldestSequence: undefined,
      complete: true,
    });
  });
});

describe('truncate', () => {
  it('leaves text at the limit alone', () => {
    expect(truncate('abc', 3)).toBe('abc');
  });
});
