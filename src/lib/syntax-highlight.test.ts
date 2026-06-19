import { describe, it, expect } from 'vitest';
import { highlightCode, highlightCodeForFile } from './syntax-highlight';

describe('highlightCode', () => {
  it('wraps tokens in hljs spans for a known language', () => {
    const html = highlightCode('const x = 1;', 'typescript');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('const');
  });

  it('escapes HTML for unknown/unsupported file types', () => {
    const html = highlightCode('<script>alert(1)</script>', 'text');
    expect(html).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('falls back to escaped plain text for a grammar-less type (prisma)', () => {
    const html = highlightCode('model User { id Int }', 'prisma');
    expect(html).toContain('model User');
    expect(html).not.toContain('hljs-');
  });

  it('escapes HTML metacharacters even within highlighted output', () => {
    const html = highlightCode('const html = "<div>" & true;', 'typescript');
    expect(html).not.toContain('<div>');
    expect(html).toContain('&lt;div&gt;');
  });

  it('maps shell file type to the bash grammar', () => {
    const html = highlightCode('echo "hi"', 'shell');
    expect(html).toContain('hljs-');
  });

  it('highlightCodeForFile resolves the language from the path', () => {
    const html = highlightCodeForFile('def f(): pass', '/tmp/foo.py');
    expect(html).toContain('hljs-keyword');
  });

  it('returns empty string for empty input', () => {
    expect(highlightCode('', 'typescript')).toBe('');
  });
});
