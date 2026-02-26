import { describe, it, expect } from 'vitest';
import { detectTriggerWord } from './trigger-word';

describe('detectTriggerWord', () => {
  describe('with trigger "Over."', () => {
    const trigger = 'Over.';

    it('detects trigger at end of transcript after sentence boundary', () => {
      expect(detectTriggerWord('Fix the bug. Over.', trigger)).toBe('Fix the bug.');
    });

    it('detects trigger with different punctuation', () => {
      expect(detectTriggerWord('Fix the bug! Over.', trigger)).toBe('Fix the bug!');
    });

    it('detects trigger without trailing punctuation', () => {
      expect(detectTriggerWord('Fix the bug. Over', trigger)).toBe('Fix the bug.');
    });

    it('detects trigger case-insensitively', () => {
      expect(detectTriggerWord('Fix the bug. over.', trigger)).toBe('Fix the bug.');
      expect(detectTriggerWord('Fix the bug. OVER.', trigger)).toBe('Fix the bug.');
      expect(detectTriggerWord('Fix the bug. over', trigger)).toBe('Fix the bug.');
    });

    it('detects trigger as entire transcript', () => {
      expect(detectTriggerWord('Over.', trigger)).toBe('');
      expect(detectTriggerWord('over', trigger)).toBe('');
      expect(detectTriggerWord('OVER', trigger)).toBe('');
    });

    it('does not trigger on "it\'s over"', () => {
      expect(detectTriggerWord("it's over", trigger)).toBeNull();
    });

    it('does not trigger on "game over"', () => {
      expect(detectTriggerWord('game over', trigger)).toBeNull();
    });

    it('does not trigger when "over" is part of a word', () => {
      expect(detectTriggerWord('I need to recover', trigger)).toBeNull();
      expect(detectTriggerWord('The overture was great', trigger)).toBeNull();
    });

    it('detects trigger after multi-sentence transcript', () => {
      expect(detectTriggerWord('First do this. Then do that. Over.', trigger)).toBe(
        'First do this. Then do that.'
      );
    });

    it('handles extra whitespace', () => {
      expect(detectTriggerWord('Fix the bug.  Over. ', trigger)).toBe('Fix the bug.');
    });

    it('handles question mark sentence boundary', () => {
      expect(detectTriggerWord('Can you fix this? Over.', trigger)).toBe('Can you fix this?');
    });
  });

  describe('edge cases', () => {
    it('returns null for empty inputs', () => {
      expect(detectTriggerWord('', 'Over.')).toBeNull();
      expect(detectTriggerWord('hello', '')).toBeNull();
      expect(detectTriggerWord('', '')).toBeNull();
    });

    it('returns null when trigger word is not present', () => {
      expect(detectTriggerWord('Just a normal sentence.', 'Over.')).toBeNull();
    });

    it('handles trigger word with no punctuation configured', () => {
      expect(detectTriggerWord('Do the thing. Send', 'Send')).toBe('Do the thing.');
    });

    it('returns null when trigger is null/undefined-like', () => {
      expect(detectTriggerWord('hello', '  ')).toBeNull();
    });
  });
});
