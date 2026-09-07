import { describe, it, expect } from 'vitest';
import { getFileType, highlightCode } from './syntax-highlight';

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

  it('returns empty string for empty input', () => {
    expect(highlightCode('', 'typescript')).toBe('');
  });

  it('skips highlighting (escaped plain text) for very large input', () => {
    const huge = `const x = "<b>";\n`.repeat(10000); // > 100k chars
    expect(huge.length).toBeGreaterThan(100_000);
    const html = highlightCode(huge, 'typescript');
    expect(html).not.toContain('hljs-');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
  });
});

describe('getFileType', () => {
  it.each([
    ['src/app.tsx', 'typescript'],
    ['lib/UTIL.JS', 'javascript'],
    ['include/foo.h', 'c'],
    ['index.html', 'html'],
    ['deploy.yml', 'yaml'],
    ['run.zsh', 'shell'],
    ['schema.prisma', 'prisma'],
  ])('maps %s to %s', (path, fileType) => {
    expect(getFileType(path)).toBe(fileType);
  });

  it('returns text for unknown or missing extensions', () => {
    expect(getFileType('LICENSE')).toBe('text');
    expect(getFileType('archive.tar.zst')).toBe('text');
  });

  it.each([
    ['html', '<div class="a">hi</div>'],
    ['docker', 'FROM node:20\nRUN npm ci'],
    ['yaml', 'key: "value"'],
    ['markdown', '# Title'],
  ])('%s is registered under its file type name', (fileType, code) => {
    expect(highlightCode(code, fileType)).toContain('hljs-');
  });
});
