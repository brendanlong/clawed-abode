import { describe, it, expect } from 'vitest';
import { MAX_CHUNK_CHARS, splitIntoSpeechChunks, splitLongSentence } from './tts';

describe('splitIntoSpeechChunks', () => {
  it('makes each sentence its own chunk', () => {
    expect(splitIntoSpeechChunks('It works. Did it? Yes!')).toEqual([
      'It works.',
      'Did it?',
      'Yes!',
    ]);
  });

  it('does not end a sentence at an abbreviation or a version number', () => {
    expect(
      splitIntoSpeechChunks('Dr. Smith visited the U.S. yesterday. Version 1.2.3 is out.')
    ).toEqual(['Dr. Smith visited the U.S. yesterday.', 'Version 1.2.3 is out.']);
  });

  it('ends a chunk at each line, for headings and list items without punctuation', () => {
    const text =
      "## Summary\nHere's what changed:\n\n- **Server**: a route\n- **Client**: a hook\n";
    expect(splitIntoSpeechChunks(text)).toEqual([
      '## Summary',
      "Here's what changed:",
      '- **Server**: a route',
      '- **Client**: a hook',
    ]);
  });

  it('keeps text without sentence punctuation whole', () => {
    expect(splitIntoSpeechChunks('  no punctuation here  ')).toEqual(['no punctuation here']);
  });

  it('returns nothing for blank text', () => {
    expect(splitIntoSpeechChunks('')).toEqual([]);
    expect(splitIntoSpeechChunks(' \n\n ')).toEqual([]);
  });

  it('splits sentences over the limit', () => {
    const clause = 'word '.repeat(10).trim();
    const sentence = `${Array.from({ length: 20 }, () => clause).join(', ')}.`;
    const chunks = splitIntoSpeechChunks(sentence);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });
});

describe('splitLongSentence', () => {
  it('returns a sentence within the limit unchanged', () => {
    expect(splitLongSentence('Short, sweet.', 20)).toEqual(['Short, sweet.']);
  });

  it('breaks at clause punctuation and packs clauses that fit together', () => {
    expect(splitLongSentence('one two, three four; five six: seven eight.', 20)).toEqual([
      'one two, three four;',
      'five six:',
      'seven eight.',
    ]);
  });

  it('falls back to word boundaries for a clause that is still too long', () => {
    expect(splitLongSentence('alpha beta gamma delta epsilon', 12)).toEqual([
      'alpha beta',
      'gamma delta',
      'epsilon',
    ]);
  });

  it('keeps a single word longer than the limit whole', () => {
    const word = 'x'.repeat(30);
    expect(splitLongSentence(`${word} end`, 10)).toEqual([word, 'end']);
  });
});
