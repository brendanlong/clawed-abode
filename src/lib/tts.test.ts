import { describe, it, expect } from 'vitest';
import { CHUNK_MAX_LENGTH, splitTextIntoChunks } from './tts';

const LIMIT = 200;
const split = (text: string) => splitTextIntoChunks(text, LIMIT);

describe('splitTextIntoChunks', () => {
  it('returns short text as a single chunk', () => {
    expect(split('Hello world.')).toEqual(['Hello world.']);
    expect(split('')).toEqual(['']);
  });

  it('never produces a chunk over the limit and reassembles to the input', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = split(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(LIMIT);
    expect(chunks.join('')).toBe(text);
  });

  it('prefers sentence boundaries', () => {
    const first = 'A'.repeat(150) + '. ';
    const second = 'B'.repeat(100) + '.';
    const chunks = split(first + second);
    expect(chunks).toEqual([first, second]);
  });

  it('treats a newline after punctuation as a sentence boundary', () => {
    const first = 'A'.repeat(150) + '?\n';
    const second = 'B'.repeat(100);
    expect(split(first + second)).toEqual([first, second]);
  });

  it('breaks at the last sentence end that fits, not an earlier one', () => {
    const first = 'A'.repeat(100) + '. ? ';
    const second = 'B'.repeat(150);
    expect(split(first + second)).toEqual([first, second]);
  });

  it('keeps a sentence end inside the chunk rather than overflowing the limit', () => {
    const fits = 'A'.repeat(LIMIT - 2) + '. ';
    expect(split(fits + 'B'.repeat(100))).toEqual([fits, 'B'.repeat(100)]);

    // The '. ' starts exactly at LIMIT, so it cannot fit in this chunk.
    const overflowing = 'A'.repeat(LIMIT) + '. ' + 'B'.repeat(100);
    const chunks = split(overflowing);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(LIMIT);
    expect(chunks.join('')).toBe(overflowing);
  });

  it('keeps a comma or semicolon inside the chunk rather than overflowing the limit', () => {
    for (const delimiter of [', ', '; ']) {
      const text = 'A'.repeat(LIMIT) + delimiter + 'B'.repeat(100);
      const chunks = split(text);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(LIMIT);
      expect(chunks.join('')).toBe(text);
    }
  });

  it('keeps a space inside the chunk rather than overflowing the limit', () => {
    const text = 'A'.repeat(LIMIT) + ' ' + 'B'.repeat(100);
    const chunks = split(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(LIMIT);
    expect(chunks.join('')).toBe(text);
  });

  it('falls back to a comma or semicolon when there is no sentence end', () => {
    const first = 'a'.repeat(120) + ', ';
    const second = 'b'.repeat(150);
    expect(split(first + second)).toEqual([first, second]);
  });

  it('falls back to a space when there is no punctuation', () => {
    const words = Array.from({ length: 60 }, () => 'word').join(' ');
    const chunks = split(words);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.endsWith(' ')).toBe(true);
    expect(chunks.join('')).toBe(words);
  });

  it('hard-splits a single unbroken token', () => {
    const token = 'x'.repeat(LIMIT * 2 + 10);
    const chunks = split(token);
    expect(chunks.map((c) => c.length)).toEqual([LIMIT, LIMIT, 10]);
  });

  it('defaults to CHUNK_MAX_LENGTH', () => {
    const text = 'x'.repeat(CHUNK_MAX_LENGTH + 1);
    expect(splitTextIntoChunks(text).map((c) => c.length)).toEqual([CHUNK_MAX_LENGTH, 1]);
  });
});
