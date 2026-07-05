import { describe, it, expect } from 'vitest';
import { buildPromptWithAttachments, sanitizeFileName } from './attachments';

describe('buildPromptWithAttachments', () => {
  it('returns the trimmed prompt unchanged when there are no attachments', () => {
    expect(buildPromptWithAttachments('  hello  ', [])).toBe('hello');
  });

  it('prefixes a single attachment path before the prompt', () => {
    expect(buildPromptWithAttachments('look at this', ['/tmp/uploads/a.md'])).toBe(
      '[User uploaded file(s): /tmp/uploads/a.md]\n\nlook at this'
    );
  });

  it('joins multiple attachment paths with a comma', () => {
    expect(buildPromptWithAttachments('review', ['/tmp/uploads/a.md', '/tmp/uploads/b.png'])).toBe(
      '[User uploaded file(s): /tmp/uploads/a.md, /tmp/uploads/b.png]\n\nreview'
    );
  });

  it('sends only the prefix when the prompt is empty but files are attached', () => {
    expect(buildPromptWithAttachments('   ', ['/tmp/uploads/a.md'])).toBe(
      '[User uploaded file(s): /tmp/uploads/a.md]'
    );
  });
});

describe('sanitizeFileName', () => {
  it('keeps a normal file name', () => {
    expect(sanitizeFileName('report.pdf')).toBe('report.pdf');
  });

  it('strips directory components (path traversal)', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('/absolute/path/file.txt')).toBe('file.txt');
    expect(sanitizeFileName('a\\b\\c.txt')).toBe('c.txt');
  });

  it('replaces unsafe characters with underscores', () => {
    expect(sanitizeFileName('my file (1).png')).toBe('my_file__1_.png');
  });

  it('strips leading dots so it never produces a dotfile', () => {
    expect(sanitizeFileName('...hidden')).toBe('hidden');
  });

  it('falls back to "file" for an empty or all-stripped name', () => {
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('...')).toBe('file');
  });
});
