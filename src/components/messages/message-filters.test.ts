import { describe, it, expect } from 'vitest';
import { getParentToolUseId, getTaskToolUseId, isToolOnlyAssistant } from './message-filters';

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

describe('getTaskToolUseId', () => {
  it('returns tool_use_id for task_started messages', () => {
    const msg = {
      id: '1',
      type: 'system',
      content: { subtype: 'task_started', tool_use_id: 'toolu_abc123' },
      sequence: 1,
    };
    expect(getTaskToolUseId(msg)).toBe('toolu_abc123');
  });

  it('returns tool_use_id for task_progress messages', () => {
    const msg = {
      id: '1',
      type: 'system',
      content: { subtype: 'task_progress', tool_use_id: 'toolu_xyz789' },
      sequence: 1,
    };
    expect(getTaskToolUseId(msg)).toBe('toolu_xyz789');
  });

  it('returns null for other system subtypes', () => {
    for (const subtype of ['init', 'error', 'hook_started', 'task_notification', 'status']) {
      const msg = {
        id: '1',
        type: 'system',
        content: { subtype, tool_use_id: 'toolu_abc' },
        sequence: 1,
      };
      expect(getTaskToolUseId(msg)).toBeNull();
    }
  });

  it('returns null for non-system messages', () => {
    const msg = {
      id: '1',
      type: 'assistant',
      content: { subtype: 'task_started', tool_use_id: 'toolu_abc' },
      sequence: 1,
    };
    expect(getTaskToolUseId(msg)).toBeNull();
  });

  it('returns null when tool_use_id is missing', () => {
    const msg = {
      id: '1',
      type: 'system',
      content: { subtype: 'task_started' },
      sequence: 1,
    };
    expect(getTaskToolUseId(msg)).toBeNull();
  });

  it('returns null when tool_use_id is not a string', () => {
    const msg = {
      id: '1',
      type: 'system',
      content: { subtype: 'task_started', tool_use_id: 42 },
      sequence: 1,
    };
    expect(getTaskToolUseId(msg)).toBeNull();
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
