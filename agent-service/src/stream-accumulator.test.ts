import { describe, it, expect, beforeEach } from 'vitest';
import { StreamAccumulator } from './stream-accumulator.js';

function makeStreamEvent(
  eventType: string,
  eventData: Record<string, unknown> = {},
  uuid = 'test-uuid',
  sessionId = 'test-session'
) {
  return {
    type: 'stream_event' as const,
    event: { type: eventType, ...eventData },
    parent_tool_use_id: null,
    uuid,
    session_id: sessionId,
  };
}

describe('StreamAccumulator', () => {
  let acc: StreamAccumulator;

  beforeEach(() => {
    acc = new StreamAccumulator();
  });

  it('should start inactive', () => {
    expect(acc.isActive).toBe(false);
    expect(acc.currentUuid).toBe('');
  });

  it('should not emit for message_start alone (no content yet)', () => {
    const result = acc.accumulate(
      makeStreamEvent('message_start', {
        message: { model: 'claude-sonnet-4-5-20250929', role: 'assistant' },
      })
    );
    expect(result).toBeNull();
    expect(acc.isActive).toBe(true);
  });

  it('should emit partial after content_block_start for text', () => {
    acc.accumulate(
      makeStreamEvent('message_start', {
        message: { model: 'claude-sonnet-4-5-20250929' },
      })
    );

    const result = acc.accumulate(
      makeStreamEvent('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      })
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('assistant');
    expect(result!.partial).toBe(true);
    expect(result!.message.content).toHaveLength(1);
    expect(result!.message.content[0]).toEqual({ type: 'text', text: '' });
  });

  it('should accumulate text deltas', () => {
    acc.accumulate(
      makeStreamEvent('message_start', {
        message: { model: 'claude-sonnet-4-5-20250929' },
      })
    );
    acc.accumulate(
      makeStreamEvent('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      })
    );

    const result1 = acc.accumulate(
      makeStreamEvent('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      })
    );
    expect(result1).not.toBeNull();
    expect(result1!.message.content[0]).toEqual({ type: 'text', text: 'Hello' });

    const result2 = acc.accumulate(
      makeStreamEvent('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: ' world' },
      })
    );
    expect(result2).not.toBeNull();
    expect(result2!.message.content[0]).toEqual({ type: 'text', text: 'Hello world' });
  });

  it('should handle tool_use blocks', () => {
    acc.accumulate(
      makeStreamEvent('message_start', {
        message: { model: 'claude-sonnet-4-5-20250929' },
      })
    );
    acc.accumulate(
      makeStreamEvent('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
      })
    );

    const result = acc.accumulate(
      makeStreamEvent('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":' },
      })
    );

    expect(result).not.toBeNull();
    const toolBlock = result!.message.content[0];
    expect(toolBlock.type).toBe('tool_use');
    if (toolBlock.type === 'tool_use') {
      expect(toolBlock.id).toBe('tool-1');
      expect(toolBlock.name).toBe('Read');
      // Partial JSON isn't valid JSON yet, so it should be stored as _partial_json
      expect(toolBlock.input).toEqual({ _partial_json: '{"file_path":' });
    }
  });

  it('should parse complete JSON input for tool_use', () => {
    acc.accumulate(
      makeStreamEvent('message_start', {
        message: { model: 'claude-sonnet-4-5-20250929' },
      })
    );
    acc.accumulate(
      makeStreamEvent('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
      })
    );

    acc.accumulate(
      makeStreamEvent('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file' },
      })
    );

    const result = acc.accumulate(
      makeStreamEvent('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '_path": "/test.ts"}' },
      })
    );

    expect(result).not.toBeNull();
    const toolBlock = result!.message.content[0];
    if (toolBlock.type === 'tool_use') {
      expect(toolBlock.input).toEqual({ file_path: '/test.ts' });
    }
  });

  it('should handle mixed text and tool_use blocks', () => {
    acc.accumulate(
      makeStreamEvent('message_start', {
        message: { model: 'claude-sonnet-4-5-20250929' },
      })
    );

    // First: text block
    acc.accumulate(
      makeStreamEvent('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      })
    );
    acc.accumulate(
      makeStreamEvent('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: 'Let me read that file.' },
      })
    );
    acc.accumulate(makeStreamEvent('content_block_stop', { index: 0 }));

    // Second: tool_use block
    acc.accumulate(
      makeStreamEvent('content_block_start', {
        index: 1,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
      })
    );
    const result = acc.accumulate(
      makeStreamEvent('content_block_delta', {
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"file_path": "/test.ts"}' },
      })
    );

    expect(result).not.toBeNull();
    expect(result!.message.content).toHaveLength(2);
    expect(result!.message.content[0]).toEqual({
      type: 'text',
      text: 'Let me read that file.',
    });
    expect(result!.message.content[1]).toEqual({
      type: 'tool_use',
      id: 'tool-1',
      name: 'Read',
      input: { file_path: '/test.ts' },
    });
  });

  it('should preserve metadata (uuid, session_id, model)', () => {
    acc.accumulate(
      makeStreamEvent(
        'message_start',
        { message: { model: 'claude-sonnet-4-5-20250929' } },
        'my-uuid',
        'my-session'
      )
    );

    const result = acc.accumulate(
      makeStreamEvent(
        'content_block_start',
        { index: 0, content_block: { type: 'text', text: '' } },
        'my-uuid',
        'my-session'
      )
    );

    expect(result).not.toBeNull();
    expect(result!.uuid).toBe('my-uuid');
    expect(result!.session_id).toBe('my-session');
    expect(result!.message.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('should set stop_reason from message_delta', () => {
    acc.accumulate(
      makeStreamEvent('message_start', {
        message: { model: 'claude-sonnet-4-5-20250929' },
      })
    );
    acc.accumulate(
      makeStreamEvent('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      })
    );
    acc.accumulate(
      makeStreamEvent('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: 'Done' },
      })
    );

    const result = acc.accumulate(
      makeStreamEvent('message_delta', {
        delta: { stop_reason: 'end_turn' },
      })
    );

    expect(result).not.toBeNull();
    expect(result!.message.stop_reason).toBe('end_turn');
  });

  it('should reset state after reset()', () => {
    acc.accumulate(
      makeStreamEvent('message_start', {
        message: { model: 'claude-sonnet-4-5-20250929' },
      })
    );
    acc.accumulate(
      makeStreamEvent('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      })
    );

    expect(acc.isActive).toBe(true);

    acc.reset();

    expect(acc.isActive).toBe(false);
    expect(acc.currentUuid).toBe('');
  });

  it('should return null for unknown event types', () => {
    acc.accumulate(
      makeStreamEvent('message_start', {
        message: { model: 'claude-sonnet-4-5-20250929' },
      })
    );

    const result = acc.accumulate(makeStreamEvent('ping', {}));
    expect(result).toBeNull();
  });

  it('should return null for events before message_start', () => {
    const result = acc.accumulate(
      makeStreamEvent('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: 'orphan' },
      })
    );
    expect(result).toBeNull();
  });

  it('should emit on message_stop', () => {
    acc.accumulate(
      makeStreamEvent('message_start', {
        message: { model: 'claude-sonnet-4-5-20250929' },
      })
    );
    acc.accumulate(
      makeStreamEvent('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      })
    );
    acc.accumulate(
      makeStreamEvent('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: 'Final content' },
      })
    );

    const result = acc.accumulate(makeStreamEvent('message_stop', {}));
    expect(result).not.toBeNull();
    expect(result!.message.content[0]).toEqual({ type: 'text', text: 'Final content' });
  });
});
