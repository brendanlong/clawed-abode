import { describe, it, expect } from 'vitest';
import { formatResumeToken, parseResumeToken, EMPTY_WATERMARK } from './sse-resume';

describe('sse-resume', () => {
  describe('formatResumeToken', () => {
    it('joins watermark and counter with a colon', () => {
      expect(formatResumeToken(42, 7)).toBe('42:7');
    });

    it('formats the empty watermark', () => {
      expect(formatResumeToken(EMPTY_WATERMARK, 0)).toBe('-1:0');
    });
  });

  describe('parseResumeToken', () => {
    it('round-trips a formatted token', () => {
      expect(parseResumeToken(formatResumeToken(42, 7))).toEqual({ watermark: 42, counter: 7 });
    });

    it('round-trips the empty watermark', () => {
      expect(parseResumeToken(formatResumeToken(EMPTY_WATERMARK, 3))).toEqual({
        watermark: -1,
        counter: 3,
      });
    });

    it('returns null for a missing token', () => {
      expect(parseResumeToken(null)).toBeNull();
      expect(parseResumeToken(undefined)).toBeNull();
      expect(parseResumeToken('')).toBeNull();
    });

    it('returns null for a token without exactly two parts', () => {
      expect(parseResumeToken('42')).toBeNull();
      expect(parseResumeToken('42:7:9')).toBeNull();
    });

    it('returns null for non-integer parts (e.g. an old-format id)', () => {
      expect(parseResumeToken('abc:7')).toBeNull();
      expect(parseResumeToken('42:xyz')).toBeNull();
      expect(parseResumeToken('partial-uuid')).toBeNull();
      expect(parseResumeToken('4.2:7')).toBeNull();
    });
  });
});
