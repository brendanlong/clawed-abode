import { describe, it, expect } from 'vitest';
import { markdownToSpeechText } from './markdown';

// Speech requests are trimmed lines (splitIntoSpeechChunks), so compare those.
const speak = (markdown: string) =>
  markdownToSpeechText(markdown)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');

describe('markdownToSpeechText', () => {
  it('reads link text but not the link target', () => {
    expect(speak('Opened [PR #123](https://github.com/o/r/pull/123).')).toBe('Opened PR #123.');
  });

  it('drops emphasis, heading and code-span syntax', () => {
    expect(speak('## Results\n\n**Done**, *mostly*: `pnpm test` & ~~old~~ new')).toBe(
      'Results\nDone, mostly: pnpm test & old new'
    );
  });

  it('keeps literal characters that markdown would escape in HTML', () => {
    expect(speak('if `a < b` && c > d')).toBe('if a < b && c > d');
  });

  it('puts each list item and table row on its own line', () => {
    expect(speak('- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |')).toBe('one\ntwo\na, b\n1, 2');
  });

  it('separates a raw HTML block from the next paragraph', () => {
    expect(speak('<details>hi</details>\n\nnext')).toBe('hi\nnext');
  });

  it('leaves out inline <unspoken> text', () => {
    expect(speak('Here is the gist. <unspoken>https://example.com/x</unspoken> Thanks.')).toBe(
      'Here is the gist.  Thanks.'
    );
  });

  it('leaves out an <unspoken> block wrapping a table', () => {
    expect(
      speak('Summary.\n<unspoken>\n| a | b |\n|---|---|\n| 1 | 2 |\n</unspoken>\nAfter.')
    ).toBe('Summary.\nAfter.');
  });

  it('speaks what follows a tag that opens a line but closes mid-line', () => {
    expect(speak('<unspoken>https://x.y/z</unspoken> is the link.\n\nSecond.')).toBe(
      'is the link.\nSecond.'
    );
    expect(speak('Intro\n<unspoken>path</unspoken> trailing\n\nNext.')).toBe(
      'Intro\ntrailing\nNext.'
    );
    expect(speak('- <unspoken>a</unspoken> item text\n- b')).toBe('item text\nb');
  });

  it('runs an unclosed inline tag to the end of its paragraph', () => {
    expect(speak('Spoken. <unspoken>not spoken\n\nSpoken again.')).toBe('Spoken.\nSpoken again.');
  });

  it('runs an unclosed block tag to the end of the message', () => {
    expect(speak('Spoken.\n<unspoken>\n| a |\n|---|\n| 1 |\n\nStill hidden.')).toBe('Spoken.');
  });

  it('keeps nested list items on their own lines', () => {
    expect(speak('- a\n  - b\n  - c\n- d')).toBe('a\nb\nc\nd');
  });

  it('treats an inline <br> as a line break', () => {
    expect(speak('one<br>two')).toBe('one\ntwo');
  });

  it('reads a literal tag inside code as code', () => {
    expect(speak('Use `<unspoken>x</unspoken>` here.')).toBe('Use <unspoken>x</unspoken> here.');
  });
});
