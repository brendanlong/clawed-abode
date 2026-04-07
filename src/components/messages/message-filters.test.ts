import { describe, it, expect } from 'vitest';
import { getParentToolUseId, isHiddenSystemMessage, isToolOnlyAssistant } from './message-filters';

describe('getParentToolUseId', () => {
  it('returns the parent_tool_use_id when present', () => {
    const msg = {
      id: '1',
      type: 'assistant',
      content: { parent_tool_use_id: 'task-123' },
      sequence: 1,
    };
    expect(getParentToolUseId(msg)).toBe('task-123');
  });

  it('returns null when parent_tool_use_id is absent', () => {
    const msg = {
      id: '1',
      type: 'assistant',
      content: { message: { content: [] } },
      sequence: 1,
    };
    expect(getParentToolUseId(msg)).toBeNull();
  });

  it('returns null when content is undefined', () => {
    const msg = { id: '1', type: 'assistant', content: undefined, sequence: 1 };
    expect(getParentToolUseId(msg)).toBeNull();
  });

  it('returns null when parent_tool_use_id is not a string', () => {
    const msg = {
      id: '1',
      type: 'assistant',
      content: { parent_tool_use_id: 42 },
      sequence: 1,
    };
    expect(getParentToolUseId(msg)).toBeNull();
  });
});

describe('isHiddenSystemMessage', () => {
  it('hides init messages', () => {
    const msg = { id: '1', type: 'system', content: { subtype: 'init' }, sequence: 1 };
    expect(isHiddenSystemMessage(msg)).toBe(true);
  });

  it('hides compact_boundary messages', () => {
    const msg = {
      id: '1',
      type: 'system',
      content: { subtype: 'compact_boundary' },
      sequence: 1,
    };
    expect(isHiddenSystemMessage(msg)).toBe(true);
  });

  it('hides hook_response messages', () => {
    const msg = {
      id: '1',
      type: 'system',
      content: { subtype: 'hook_response' },
      sequence: 1,
    };
    expect(isHiddenSystemMessage(msg)).toBe(true);
  });

  it('keeps hook_started messages visible', () => {
    const msg = {
      id: '1',
      type: 'system',
      content: { subtype: 'hook_started' },
      sequence: 1,
    };
    expect(isHiddenSystemMessage(msg)).toBe(false);
  });

  it('keeps error messages visible', () => {
    const msg = { id: '1', type: 'system', content: { subtype: 'error' }, sequence: 1 };
    expect(isHiddenSystemMessage(msg)).toBe(false);
  });

  it('keeps messages with unknown subtypes visible', () => {
    const msg = {
      id: '1',
      type: 'system',
      content: { subtype: 'some_future_type' },
      sequence: 1,
    };
    expect(isHiddenSystemMessage(msg)).toBe(false);
  });

  it('keeps messages with no subtype visible', () => {
    const msg = { id: '1', type: 'system', content: {}, sequence: 1 };
    expect(isHiddenSystemMessage(msg)).toBe(false);
  });

  it('keeps messages with undefined content visible', () => {
    const msg = { id: '1', type: 'system', content: undefined, sequence: 1 };
    expect(isHiddenSystemMessage(msg)).toBe(false);
  });

  it('returns false for non-system messages', () => {
    const msg = { id: '1', type: 'assistant', content: { subtype: 'init' }, sequence: 1 };
    expect(isHiddenSystemMessage(msg)).toBe(false);
  });
});

describe('isToolOnlyAssistant', () => {
  it('returns true for assistant with only tool_use blocks', () => {
    const msg = {
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
    };
    expect(isToolOnlyAssistant(msg)).toBe(true);
  });

  it('returns false for assistant with text and tool_use', () => {
    const msg = {
      id: '1',
      type: 'assistant',
      content: {
        message: {
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 't1', name: 'Read', input: {} },
          ],
        },
      },
      sequence: 1,
    };
    expect(isToolOnlyAssistant(msg)).toBe(false);
  });

  it('returns false for assistant with only text', () => {
    const msg = {
      id: '1',
      type: 'assistant',
      content: {
        message: {
          content: [{ type: 'text', text: 'Hello!' }],
        },
      },
      sequence: 1,
    };
    expect(isToolOnlyAssistant(msg)).toBe(false);
  });

  it('returns false for assistant with empty content array', () => {
    const msg = {
      id: '1',
      type: 'assistant',
      content: { message: { content: [] } },
      sequence: 1,
    };
    expect(isToolOnlyAssistant(msg)).toBe(false);
  });

  it('returns false for non-assistant messages', () => {
    const msg = {
      id: '1',
      type: 'user',
      content: {
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        },
      },
      sequence: 1,
    };
    expect(isToolOnlyAssistant(msg)).toBe(false);
  });

  it('returns false when content is undefined', () => {
    const msg = { id: '1', type: 'assistant', content: undefined, sequence: 1 };
    expect(isToolOnlyAssistant(msg)).toBe(false);
  });
});
