import { describe, it, expect } from 'vitest';
import { joinSpeechText } from './speech-transcript';

describe('joinSpeechText', () => {
  it('adds a space between parts that lack one', () => {
    expect(joinSpeechText('hello world', 'how are you')).toBe('hello world how are you');
  });

  it('keeps existing whitespace at the boundary instead of doubling it', () => {
    expect(joinSpeechText('hello', ' world')).toBe('hello world');
    expect(joinSpeechText('typed line\n', 'spoken')).toBe('typed line\nspoken');
  });

  it('skips empty parts without adding stray spaces', () => {
    expect(joinSpeechText('', 'hello', '', 'world', '')).toBe('hello world');
    expect(joinSpeechText()).toBe('');
  });
});
