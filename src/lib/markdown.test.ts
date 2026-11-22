import { describe, it, expect } from 'vitest';
import { markdownToSpeechText } from './markdown';

const speak = (markdown: string) => markdownToSpeechText(markdown).trim();

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

  it('treats an unclosed <unspoken> as running to the end', () => {
    expect(speak('Spoken. <unspoken>not spoken')).toBe('Spoken.');
  });

  it('reads a literal tag inside code as code', () => {
    expect(speak('Use `<unspoken>x</unspoken>` here.')).toBe('Use <unspoken>x</unspoken> here.');
  });
});
