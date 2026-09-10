import { describe, it, expect } from 'vitest';
import { escapeHtml, escapeHtmlAttribute } from './html-escape';

describe('escapeHtmlAttribute', () => {
  it('escapes both quote characters so a value cannot break out of an attribute', () => {
    expect(escapeHtmlAttribute('" onmouseover="alert(1)')).toBe(
      '&quot; onmouseover=&quot;alert(1)'
    );
    expect(escapeHtmlAttribute("' onmouseover='alert(1)")).toBe('&#39; onmouseover=&#39;alert(1)');
  });

  it('escapes tag metacharacters', () => {
    expect(escapeHtmlAttribute('<img src=x>')).toBe('&lt;img src=x&gt;');
  });

  it('leaves ampersands alone so query strings survive intact', () => {
    expect(escapeHtmlAttribute('https://example.com/?a=1&b=2')).toBe(
      'https://example.com/?a=1&b=2'
    );
  });

  it('returns text without metacharacters unchanged', () => {
    expect(escapeHtmlAttribute('https://example.com/path')).toBe('https://example.com/path');
    expect(escapeHtmlAttribute('')).toBe('');
  });
});

describe('escapeHtml', () => {
  it('escapes tag metacharacters', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes ampersands so existing entities render literally', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('escapes quotes', () => {
    expect(escapeHtml(`"'`)).toBe('&quot;&#39;');
  });
});
