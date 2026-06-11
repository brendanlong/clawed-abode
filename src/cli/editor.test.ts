import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { stripCommentLines, parseEditorDocument } from './editor';

describe('stripCommentLines', () => {
  it('removes // comment lines but keeps JSON content', () => {
    const text = '// help text\n//more help\n{\n  "url": "https://example.com/path"\n}';
    expect(stripCommentLines(text)).toBe('{\n  "url": "https://example.com/path"\n}');
  });

  it('does not strip URLs inside strings', () => {
    const text = '{ "url": "https://example.com" }';
    expect(stripCommentLines(text)).toBe(text);
  });
});

describe('parseEditorDocument', () => {
  const schema = z.object({ name: z.string(), count: z.number() });

  it('parses a valid document with comments', () => {
    const result = parseEditorDocument(schema, '// header\n{ "name": "a", "count": 1 }');
    expect(result).toEqual({ ok: true, value: { name: 'a', count: 1 } });
  });

  it('reports JSON syntax errors', () => {
    const result = parseEditorDocument(schema, '{ not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Invalid JSON');
  });

  it('reports zod validation issues with paths', () => {
    const result = parseEditorDocument(schema, '{ "name": "a", "count": "wrong" }');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('count');
  });
});
