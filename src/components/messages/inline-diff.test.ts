import { describe, it, expect } from 'vitest';
import { computeInlineDiff, diffStats, type DiffLine } from './inline-diff';

/** Join a line's segments back into its full text. */
function lineText(line: DiffLine): string {
  return line.segments.map((s) => s.value).join('');
}

/** Concatenate only the highlighted (changed) text on a line. */
function highlightedText(line: DiffLine): string {
  return line.segments
    .filter((s) => s.highlight)
    .map((s) => s.value)
    .join('');
}

describe('computeInlineDiff', () => {
  it('returns no lines for identical input', () => {
    const lines = computeInlineDiff('a\nb\nc\n', 'a\nb\nc\n');
    expect(lines.every((l) => l.type === 'context')).toBe(true);
    expect(diffStats(lines)).toEqual({ added: 0, removed: 0 });
  });

  it('treats a pure insertion as all added lines', () => {
    const lines = computeInlineDiff('', 'hello\nworld\n');
    expect(lines.map((l) => l.type)).toEqual(['add', 'add']);
    expect(lines.map(lineText)).toEqual(['hello', 'world']);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 0 });
  });

  it('treats a pure deletion as all removed lines', () => {
    const lines = computeInlineDiff('hello\nworld\n', '');
    expect(lines.map((l) => l.type)).toEqual(['remove', 'remove']);
    expect(diffStats(lines)).toEqual({ added: 0, removed: 2 });
  });

  it('keeps unchanged lines as context surrounding a change', () => {
    const lines = computeInlineDiff('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
    expect(lines.map((l) => `${l.type}:${lineText(l)}`)).toEqual([
      'context:one',
      'remove:two',
      'add:TWO',
      'context:three',
    ]);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });

  it('emits removed lines before added lines for a modification', () => {
    const lines = computeInlineDiff('alpha\nbeta\n', 'gamma\ndelta\n');
    expect(lines.map((l) => l.type)).toEqual(['remove', 'remove', 'add', 'add']);
  });

  it('highlights only the changed words within a modified line', () => {
    const lines = computeInlineDiff('the quick brown fox\n', 'the slow brown fox\n');
    const removed = lines.find((l) => l.type === 'remove')!;
    const added = lines.find((l) => l.type === 'add')!;
    expect(highlightedText(removed)).toBe('quick');
    expect(highlightedText(added)).toBe('slow');
    // Unchanged words on the line are not highlighted.
    expect(lineText(removed)).toBe('the quick brown fox');
    expect(lineText(added)).toBe('the slow brown fox');
  });

  it('preserves intentional blank lines in the middle of a block', () => {
    const lines = computeInlineDiff('', 'a\n\nb\n');
    expect(lines.map(lineText)).toEqual(['a', '', 'b']);
    expect(lines.every((l) => l.type === 'add')).toBe(true);
  });

  it('handles content without a trailing newline', () => {
    const lines = computeInlineDiff('a\nb', 'a\nc');
    expect(lines.map((l) => `${l.type}:${lineText(l)}`)).toEqual([
      'context:a',
      'remove:b',
      'add:c',
    ]);
  });

  it('handles empty input on both sides', () => {
    expect(computeInlineDiff('', '')).toEqual([]);
    expect(diffStats(computeInlineDiff('', ''))).toEqual({ added: 0, removed: 0 });
  });

  it('falls back to plain line diff (no word highlighting) for very large blocks', () => {
    // Build a modified region whose combined size exceeds the word-diff cap.
    const big = 'x'.repeat(15000);
    const oldString = `${big}old\n`;
    const newString = `${big}new\n`;
    const lines = computeInlineDiff(oldString, newString);

    // Still produces the removed-then-added line structure...
    expect(lines.map((l) => l.type)).toEqual(['remove', 'add']);
    // ...but skips the expensive word-level highlighting.
    expect(lines.every((l) => l.segments.every((s) => !s.highlight))).toBe(true);
  });

  it('still does word-level highlighting for normal-sized blocks', () => {
    const lines = computeInlineDiff('small old line\n', 'small new line\n');
    expect(lines.some((l) => l.segments.some((s) => s.highlight))).toBe(true);
  });
});
