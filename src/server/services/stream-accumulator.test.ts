import { describe, it, expect } from 'vitest';
import type { SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import { StreamAccumulator } from './stream-accumulator';

/**
 * Helper to wrap a raw stream event in the message envelope the accumulator expects.
 * Events are written partially (as the real stream's often are), hence the cast.
 */
function event(
  e: Record<string, unknown>,
  parentToolUseId: string | null = null
): SDKPartialAssistantMessage {
  return {
    type: 'stream_event',
    event: e,
    parent_tool_use_id: parentToolUseId,
    uuid: 'uuid-1',
    session_id: 'session-1',
  } as unknown as SDKPartialAssistantMessage;
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

  describe('interleaved subagent streams', () => {
    const start = (parent: string | null) =>
      event({ type: 'message_start', message: { model: 'opus' } }, parent);
    const textBlock = (parent: string | null) =>
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, parent);
    const text = (t: string, parent: string | null) =>
      event(
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } },
        parent
      );

    it('accumulates each agent into its own partial', () => {
      const acc = new StreamAccumulator();
      acc.accumulate(start(null));
      acc.accumulate(textBlock(null));
      acc.accumulate(text('main ', null));
      acc.accumulate(start('task-1'));
      acc.accumulate(textBlock('task-1'));
      const sub = acc.accumulate(text('sub', 'task-1'));
      const main = acc.accumulate(text('agent', null));

      expect(main?.parent_tool_use_id).toBeNull();
      expect(main?.message.content).toEqual([{ type: 'text', text: 'main agent' }]);
      expect(sub?.parent_tool_use_id).toBe('task-1');
      expect(sub?.message.content).toEqual([{ type: 'text', text: 'sub' }]);
    });

    it("keeps streaming the main agent after a subagent's message completes", () => {
      const acc = new StreamAccumulator();
      acc.accumulate(start(null));
      acc.accumulate(textBlock(null));
      acc.accumulate(start('task-1'));
      acc.accumulate(textBlock('task-1'));
      acc.accumulate(text('sub', 'task-1'));
      acc.completeMessage('task-1');

      const main = acc.accumulate(text('still streaming', null));
      expect(main?.message.content).toEqual([{ type: 'text', text: 'still streaming' }]);
      expect(acc.accumulate(text('late', 'task-1'))).toBeNull();
    });

    it('discards every stream on resetAll', () => {
      const acc = new StreamAccumulator();
      acc.accumulate(start(null));
      acc.accumulate(textBlock(null));
      acc.accumulate(start('task-1'));
      acc.accumulate(textBlock('task-1'));
      acc.resetAll();

      expect(acc.accumulate(text('x', null))).toBeNull();
      expect(acc.accumulate(text('x', 'task-1'))).toBeNull();
    });
  });
});
