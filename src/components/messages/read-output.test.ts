import { describe, it, expect } from 'vitest';
import { parseReadOutput } from './read-output';

describe('parseReadOutput', () => {
  it('strips arrow-style line-number prefixes', () => {
    const output = '     1→const x = 1;\n     2→const y = 2;\n';
    expect(parseReadOutput(output)).toEqual({
      code: 'const x = 1;\nconst y = 2;',
      lineCount: 2,
    });
  });

  it('strips cat -n tab-style line-number prefixes', () => {
    const output = '     1\tfoo\n     2\tbar\n';
    expect(parseReadOutput(output)).toEqual({ code: 'foo\nbar', lineCount: 2 });
  });

  it('preserves content indentation after the prefix', () => {
    const output = '     1→function f() {\n     2→  return 1;\n     3→}\n';
    expect(parseReadOutput(output).code).toBe('function f() {\n  return 1;\n}');
  });

  it('only consumes the first separator, keeping arrows/tabs in content', () => {
    const output = '     1→a → b\n';
    expect(parseReadOutput(output).code).toBe('a → b');
  });

  it('drops injected system-reminder lines', () => {
    const output = '     1→code\n<system-reminder>note</system-reminder>\n     2→more\n';
    expect(parseReadOutput(output)).toEqual({ code: 'code\nmore', lineCount: 2 });
  });

  it('leaves raw content without prefixes untouched', () => {
    const output = 'plain line one\nplain line two\n';
    expect(parseReadOutput(output)).toEqual({
      code: 'plain line one\nplain line two',
      lineCount: 2,
    });
  });

  it('does not strip numeric-tab lines in raw (unnumbered) content', () => {
    // First line has no prefix, so this is not Read's numbered output; a later
    // "42\tvalue" line must be preserved verbatim rather than stripped.
    const output = 'header\n42\tvalue\n';
    expect(parseReadOutput(output)).toEqual({
      code: 'header\n42\tvalue',
      lineCount: 2,
    });
  });

  it('handles empty and non-string input', () => {
    expect(parseReadOutput('')).toEqual({ code: '', lineCount: 0 });
    expect(parseReadOutput(undefined)).toEqual({ code: '', lineCount: 0 });
    expect(parseReadOutput(42)).toEqual({ code: '', lineCount: 0 });
  });
});
