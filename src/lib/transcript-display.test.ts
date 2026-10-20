import { describe, it, expect } from 'vitest';
import { isToolResultMessage, isTranscriptRow, messageDisplay } from './transcript-display';

const textBlocks = (text: string) => ({ message: { content: [{ type: 'text', text }] } });
const toolResult = {
  message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
};

describe('messageDisplay', () => {
  it('makes top-level prompts, replies, results and visible system messages rows', () => {
    expect(messageDisplay('user', { type: 'user', content: 'hi' })).toBe('row');
    expect(messageDisplay('assistant', textBlocks('hello'))).toBe('row');
    expect(messageDisplay('result', { type: 'result', subtype: 'success' })).toBe('row');
    for (const subtype of ['error', 'compact_boundary', 'model_refusal_fallback']) {
      expect(messageDisplay('system', { subtype })).toBe('row');
    }
  });

  it('keeps an unrecognized message type a row, so it still shows as raw JSON', () => {
    expect(messageDisplay('mystery', { foo: 1 })).toBe('row');
  });

  it('makes tool results context, top-level or not', () => {
    expect(messageDisplay('user', toolResult)).toBe('context');
    expect(messageDisplay('user', { ...toolResult, parent_tool_use_id: 'task-1' })).toBe('context');
  });

  it('makes background-task lifecycle events context', () => {
    expect(messageDisplay('system', { subtype: 'task_started', tool_use_id: 'a' })).toBe('context');
    expect(messageDisplay('system', { subtype: 'task_notification', tool_use_id: 'a' })).toBe(
      'context'
    );
  });

  it('makes subagent messages that render in their Task box context', () => {
    expect(
      messageDisplay('assistant', { ...textBlocks('child'), parent_tool_use_id: 'task-1' })
    ).toBe('context');
    expect(messageDisplay('system', { subtype: 'error', parent_tool_use_id: 'task-1' })).toBe(
      'context'
    );
  });

  it('hides other system messages, top-level or not', () => {
    for (const subtype of ['init', 'hook_started', 'hook_response', 'background_tasks_changed']) {
      expect(messageDisplay('system', { subtype })).toBe('hidden');
    }
    // No subtype at all (e.g. a stored rate_limit_event).
    expect(messageDisplay('system', { type: 'rate_limit_event' })).toBe('hidden');
    expect(messageDisplay('system', { parent_tool_use_id: 'task-1' })).toBe('hidden');
  });

  it('hides assistant fragments that render nothing, top-level or not', () => {
    const empty = { message: { content: [{ type: 'thinking', thinking: '', signature: 's' }] } };
    expect(messageDisplay('assistant', empty)).toBe('hidden');
    expect(messageDisplay('assistant', { ...empty, parent_tool_use_id: 'task-1' })).toBe('hidden');
  });

  it('treats malformed content as an ordinary row instead of throwing', () => {
    expect(messageDisplay('user', null)).toBe('row');
    expect(messageDisplay('assistant', 'text')).toBe('row');
    expect(messageDisplay('assistant', { message: 'not an object' })).toBe('row');
  });
});

describe('isTranscriptRow', () => {
  it('ignores nesting: a subagent message is a row of its nested transcript', () => {
    expect(
      isTranscriptRow('assistant', { ...textBlocks('child'), parent_tool_use_id: 'task-1' })
    ).toBe(true);
  });

  it('never makes a tool result, hidden system message or empty fragment a row', () => {
    expect(isTranscriptRow('user', toolResult)).toBe(false);
    expect(isTranscriptRow('system', { subtype: 'task_started' })).toBe(false);
    expect(isTranscriptRow('assistant', textBlocks('  '))).toBe(false);
  });

  it('hides only system messages by subtype, never other types', () => {
    expect(isTranscriptRow('assistant', { subtype: 'init', ...textBlocks('hi') })).toBe(true);
    expect(isTranscriptRow('result', { subtype: 'success' })).toBe(true);
  });
});

describe('isToolResultMessage', () => {
  it('is true for messages with tool_result content', () => {
    expect(isToolResultMessage(toolResult)).toBe(true);
  });

  it('is false for messages without tool_result content', () => {
    expect(isToolResultMessage(textBlocks('hello'))).toBe(false);
  });

  it('is false when the message has no content array', () => {
    expect(isToolResultMessage({ content: 'text' })).toBe(false);
  });
});

describe('assistant messages that render nothing', () => {
  const isRow = (...content: unknown[]) =>
    messageDisplay('assistant', { message: { content } }) === 'row';

  it('hides a message whose only block is empty thinking', () => {
    expect(isRow({ type: 'thinking', thinking: '', signature: 'sig' })).toBe(false);
  });

  it('shows a message that is only a progress update', () => {
    expect(isRow({ type: 'thinking', thinking: 'Running the tests now.' })).toBe(true);
  });

  it('hides ASCII-whitespace-only text and an empty block array', () => {
    expect(isRow({ type: 'text', text: ' \t\n\v\f\r' })).toBe(false);
    expect(isRow()).toBe(false);
  });

  it('counts only ASCII whitespace as blank, matching the backfill SQL', () => {
    // A no-break space is not ASCII whitespace, so it is text.
    expect(isRow({ type: 'text', text: '\u00a0' })).toBe(true);
  });

  it('shows a message when any block has real content', () => {
    expect(isRow({ type: 'thinking', thinking: '' }, { type: 'text', text: 'hi' })).toBe(true);
    expect(isRow({ type: 'tool_use', id: 't1', name: 'Bash', input: {} })).toBe(true);
    expect(isRow({ type: 'redacted_thinking' })).toBe(true);
    expect(isRow({ type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} })).toBe(
      true
    );
  });

  it('hides a message whose only block is an advisor_tool_result (encrypted)', () => {
    expect(
      isRow({
        type: 'advisor_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: { type: 'advisor_redacted_result', encrypted_content: 'abc' },
      })
    ).toBe(false);
  });

  it('ignores blocks that are not objects', () => {
    expect(isRow('hello', null, 3)).toBe(false);
    expect(isRow(null, { type: 'text', text: 'hi' })).toBe(true);
  });

  it('shows non-array content (handled elsewhere) and null content', () => {
    expect(messageDisplay('assistant', { content: 'plain' })).toBe('row');
    expect(messageDisplay('assistant', null)).toBe('row');
  });
});
