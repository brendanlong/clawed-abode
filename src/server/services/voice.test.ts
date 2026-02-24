import { describe, it, expect } from 'vitest';
import { needsTransformation, splitTextForTTS } from './voice';

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
});
