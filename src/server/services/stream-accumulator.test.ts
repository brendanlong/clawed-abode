import { describe, it, expect } from 'vitest';
import { StreamAccumulator } from './stream-accumulator';

/**
 * Helper to wrap a raw stream event in the message envelope the accumulator expects.
 */
function event(e: Record<string, unknown>) {
  return {
    type: 'stream_event' as const,
    event: e as { type: string; [key: string]: unknown },
    parent_tool_use_id: null,
    uuid: 'uuid-1',
    session_id: 'session-1',
  };
}

describe('StreamAccumulator', () => {
  it('accumulates text deltas into a text block', () => {
    const acc = new StreamAccumulator();
    acc.accumulate(event({ type: 'message_start', message: { model: 'opus' } }));
    acc.accumulate(
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
    );
    acc.accumulate(
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello ' },
      })
    );
    const partial = acc.accumulate(
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } })
    );

    expect(partial?.message.content).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('accumulates thinking deltas into a thinking block', () => {
    const acc = new StreamAccumulator();
    acc.accumulate(event({ type: 'message_start', message: {} }));
    acc.accumulate(
      event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })
    );
    acc.accumulate(
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'I should ' },
      })
    );
    const partial = acc.accumulate(
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'check this' },
      })
    );

    expect(partial?.message.content).toEqual([
      { type: 'thinking', thinking: 'I should check this' },
    ]);
  });

  it('keeps thinking and following text blocks aligned by index', () => {
    const acc = new StreamAccumulator();
    acc.accumulate(event({ type: 'message_start', message: {} }));
    // Thinking block at index 0
    acc.accumulate(
      event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })
    );
    acc.accumulate(
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'reasoning' },
      })
    );
    // Text block at index 1
    acc.accumulate(
      event({ type: 'content_block_start', index: 1, content_block: { type: 'text' } })
    );
    const partial = acc.accumulate(
      event({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'answer' },
      })
    );

    expect(partial?.message.content).toEqual([
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('drops unrenderable blocks (redacted_thinking) but keeps indices aligned', () => {
    const acc = new StreamAccumulator();
    acc.accumulate(event({ type: 'message_start', message: {} }));
    // Unknown/redacted block at index 0 (placeholder, not emitted)
    acc.accumulate(
      event({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } })
    );
    // Text block at index 1 must still receive its deltas
    acc.accumulate(
      event({ type: 'content_block_start', index: 1, content_block: { type: 'text' } })
    );
    const partial = acc.accumulate(
      event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } })
    );

    expect(partial?.message.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('returns null when only placeholder blocks exist', () => {
    const acc = new StreamAccumulator();
    acc.accumulate(event({ type: 'message_start', message: {} }));
    const partial = acc.accumulate(
      event({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } })
    );
    expect(partial).toBeNull();
  });
});
