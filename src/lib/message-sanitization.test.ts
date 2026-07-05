import { describe, it, expect } from 'vitest';
import { attachToolResultSanitizations } from './message-sanitization';
import type { SanitizationInfo } from './sanitization';

const info = (removed: boolean): SanitizationInfo => ({
  found: ['invisible-unicode'],
  warnings: ['stripped 1 char'],
  removed,
});

/** A minimal user tool_result message as it arrives from the SDK stream. */
function toolResultMessage(toolUseId: string) {
  return {
    type: 'user',
    session_id: 's1',
    uuid: 'u1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'output text' }],
    },
  };
}

describe('attachToolResultSanitizations', () => {
  it('attaches findings to the matching tool_result block and consumes the entry', () => {
    const message = toolResultMessage('toolu_1');
    const map = new Map([['toolu_1', info(true)]]);

    attachToolResultSanitizations(message, map);

    const block = message.message.content[0] as { sanitization?: SanitizationInfo };
    expect(block.sanitization).toEqual(info(true));
    // Consumed so it is only attached once.
    expect(map.has('toolu_1')).toBe(false);
  });

  it('leaves blocks without a matching finding untouched', () => {
    const message = toolResultMessage('toolu_other');
    const map = new Map([['toolu_1', info(true)]]);

    attachToolResultSanitizations(message, map);

    const block = message.message.content[0] as { sanitization?: SanitizationInfo };
    expect(block.sanitization).toBeUndefined();
    // Nothing matched → the entry stays for a later message.
    expect(map.has('toolu_1')).toBe(true);
  });

  it('attaches per-block when a message carries several tool_results', () => {
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'x' },
          { type: 'tool_result', tool_use_id: 'b', content: 'y' },
        ],
      },
    };
    const map = new Map([
      ['a', info(true)],
      ['b', info(false)],
    ]);

    attachToolResultSanitizations(message, map);

    const [ba, bb] = message.message.content as Array<{ sanitization?: SanitizationInfo }>;
    expect(ba.sanitization?.removed).toBe(true);
    expect(bb.sanitization?.removed).toBe(false);
    expect(map.size).toBe(0);
  });

  it('is a no-op for an empty map or non-tool_result content', () => {
    const empty = new Map<string, SanitizationInfo>();
    const message = toolResultMessage('toolu_1');
    attachToolResultSanitizations(message, empty);
    expect(
      (message.message.content[0] as { sanitization?: SanitizationInfo }).sanitization
    ).toBeUndefined();

    // A plain prompt echo (no message.content array) matches nothing and does not throw.
    const map = new Map([['toolu_1', info(true)]]);
    expect(() =>
      attachToolResultSanitizations({ type: 'user', content: 'hello' }, map)
    ).not.toThrow();
    expect(map.has('toolu_1')).toBe(true);
  });
});
