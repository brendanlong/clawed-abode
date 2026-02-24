import { describe, it, expect } from 'vitest';
import { needsTransformation, splitTextForTTS, splitTextAtWordBoundary } from './voice';

describe('needsTransformation', () => {
  it('should return true for text with markdown tables', () => {
    expect(needsTransformation('| Col1 | Col2 |\n| --- | --- |\n| A | B |')).toBe(true);
  });

  it('should return true for text with code blocks', () => {
    expect(needsTransformation('Here is code:\n```\nconst x = 1;\n```')).toBe(true);
  });

  it('should return true for text with headers', () => {
    expect(needsTransformation('# Title\nSome content')).toBe(true);
  });

  it('should return true for text with links', () => {
    expect(needsTransformation('See [this link](https://example.com)')).toBe(true);
  });

  it('should return true for text with bullet lists', () => {
    expect(needsTransformation('Items:\n- Item 1\n- Item 2')).toBe(true);
  });

  it('should return false for plain text', () => {
    expect(needsTransformation('This is just regular text.')).toBe(false);
  });

  it('should return false for empty text', () => {
    expect(needsTransformation('')).toBe(false);
  });
});

describe('splitTextAtWordBoundary', () => {
  it('should return full text when under limit', () => {
    const [chunk, remainder] = splitTextAtWordBoundary('hello world', 20);
    expect(chunk).toBe('hello world');
    expect(remainder).toBe('');
  });

  it('should split at last space within limit', () => {
    const [chunk, remainder] = splitTextAtWordBoundary('hello beautiful world', 15);
    expect(chunk).toBe('hello beautiful');
    expect(remainder).toBe('world');
  });

  it('should not split mid-word', () => {
    const text = 'abcdefghij klmnopqrst';
    const [chunk, remainder] = splitTextAtWordBoundary(text, 15);
    // Splits at the space between the two words, not mid-word
    expect(chunk).toBe('abcdefghij');
    expect(remainder).toBe('klmnopqrst');
    // The chunk should not contain a partial word — verify the split
    // happened at a word boundary (space position 10), not at position 15
    expect(chunk.length).toBeLessThanOrEqual(15);
    expect(chunk).not.toContain(' klm');
  });

  it('should hard split when no spaces exist', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const [chunk, remainder] = splitTextAtWordBoundary(text, 10);
    expect(chunk).toBe('abcdefghij');
    expect(remainder).toBe('klmnopqrstuvwxyz');
  });

  it('should handle exact length text', () => {
    const text = 'exact';
    const [chunk, remainder] = splitTextAtWordBoundary(text, 5);
    expect(chunk).toBe('exact');
    expect(remainder).toBe('');
  });
});

describe('splitTextForTTS', () => {
  it('should return single chunk for short text', () => {
    const text = 'Hello, this is a short message.';
    const chunks = splitTextForTTS(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('should split long text on paragraph boundaries', () => {
    const paragraph = 'A'.repeat(3000);
    const text = `${paragraph}\n\n${paragraph}`;
    const chunks = splitTextForTTS(text);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk) => {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    });
  });

  it('should handle text with no paragraph breaks', () => {
    // A single very long sentence
    const longSentence = 'word '.repeat(1000);
    const chunks = splitTextForTTS(longSentence);
    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach((chunk) => {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    });
  });

  it('should handle empty text', () => {
    const chunks = splitTextForTTS('');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('');
  });

  it('should split long sentences at word boundaries, not mid-word', () => {
    // Create a sentence longer than TTS_MAX_CHARS with words
    const words = Array.from({ length: 1000 }, (_, i) => `word${i}`);
    const longSentence = words.join(' ') + '.';
    const chunks = splitTextForTTS(longSentence);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      // Each chunk should not start or end with a partial word (no splits mid-word)
      // This means chunks should not start with a lowercase continuation
      if (chunk !== chunks[0]) {
        expect(chunk).toMatch(/^\S/); // starts with non-space
      }
    }

    // Verify all content is preserved (no dropped remainder)
    const rejoined = chunks.join(' ');
    expect(rejoined).toContain('word0');
    expect(rejoined).toContain('word999');
  });

  it('should not drop remainder text from long sentences', () => {
    // Create text that will require multiple splits of a single long sentence
    const longWord = 'test ';
    const longSentence = longWord.repeat(2000).trim();
    const chunks = splitTextForTTS(longSentence);

    const totalChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    // Allow for whitespace differences but total content should be close
    expect(totalChars).toBeGreaterThanOrEqual(longSentence.length * 0.95);
  });
});
