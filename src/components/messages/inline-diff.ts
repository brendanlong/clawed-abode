import { diffLines, diffWordsWithSpace, type Change } from 'diff';

/**
 * A contiguous run of text within a single diff line. `highlight` marks the
 * portion that actually changed (word-level), so unchanged words on a modified
 * line can be rendered without emphasis.
 */
export interface DiffSegment {
  value: string;
  highlight: boolean;
}

/** A single rendered line of an inline (unified) diff. */
export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  segments: DiffSegment[];
}

/** Summary counts for a diff, useful for a header badge. */
export interface DiffStats {
  added: number;
  removed: number;
}

/**
 * Above this combined character count for a modified region, skip the
 * super-linear word-level diff and fall back to plain line-level rendering.
 * Word diffing a multi-thousand-line block on the render thread can freeze the
 * UI; line-level output is still useful and cheap.
 */
const WORD_DIFF_MAX_CHARS = 20000;

/**
 * Split a flat list of segments into per-line segments, breaking on newline
 * characters embedded in segment values. A trailing newline produces no extra
 * blank line (it terminates the preceding line rather than starting a new one).
 */
function segmentsToLines(
  segments: DiffSegment[],
  fullText: string,
  type: DiffLine['type']
): DiffLine[] {
  if (fullText === '') return [];

  const lines: DiffLine[] = [{ type, segments: [] }];
  for (const seg of segments) {
    const pieces = seg.value.split('\n');
    for (let p = 0; p < pieces.length; p++) {
      if (p > 0) lines.push({ type, segments: [] });
      const piece = pieces[p];
      if (piece.length > 0) {
        lines[lines.length - 1].segments.push({ value: piece, highlight: seg.highlight });
      }
    }
  }

  // A trailing newline leaves an empty artifact line; drop it.
  if (fullText.endsWith('\n')) lines.pop();
  return lines;
}

/** Build lines for a block that is entirely added, removed, or context. */
function plainLines(value: string, type: DiffLine['type']): DiffLine[] {
  return segmentsToLines([{ value, highlight: false }], value, type);
}

/**
 * Pair an adjacent removed block and added block (a modification region) and
 * compute word-level highlighting within them so only the changed words are
 * emphasized on each side.
 */
function pairedLines(removedText: string, addedText: string): DiffLine[] {
  const wordChanges = diffWordsWithSpace(removedText, addedText);
  const removedSegs: DiffSegment[] = [];
  const addedSegs: DiffSegment[] = [];

  for (const w of wordChanges) {
    if (w.added) {
      addedSegs.push({ value: w.value, highlight: true });
    } else if (w.removed) {
      removedSegs.push({ value: w.value, highlight: true });
    } else {
      removedSegs.push({ value: w.value, highlight: false });
      addedSegs.push({ value: w.value, highlight: false });
    }
  }

  return [
    ...segmentsToLines(removedSegs, removedText, 'remove'),
    ...segmentsToLines(addedSegs, addedText, 'add'),
  ];
}

/**
 * Compute an inline (unified) diff between two strings as a flat list of lines.
 * Removed and added lines are paired for word-level highlighting where a region
 * was modified; pure insertions/deletions and unchanged context are emitted
 * line-by-line. Pure function — safe to unit test and memoize.
 */
export function computeInlineDiff(oldString: string, newString: string): DiffLine[] {
  const changes: Change[] = diffLines(oldString, newString);
  const lines: DiffLine[] = [];

  let i = 0;
  while (i < changes.length) {
    const change = changes[i];
    const next = changes[i + 1];

    if (change.removed && next?.added) {
      // Skip word-level pairing for very large regions to keep rendering cheap.
      if (change.value.length + next.value.length > WORD_DIFF_MAX_CHARS) {
        lines.push(...plainLines(change.value, 'remove'));
        lines.push(...plainLines(next.value, 'add'));
      } else {
        lines.push(...pairedLines(change.value, next.value));
      }
      i += 2;
    } else if (change.removed) {
      lines.push(...plainLines(change.value, 'remove'));
      i += 1;
    } else if (change.added) {
      lines.push(...plainLines(change.value, 'add'));
      i += 1;
    } else {
      lines.push(...plainLines(change.value, 'context'));
      i += 1;
    }
  }

  return lines;
}

/** Count added/removed lines from a computed diff. */
export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'add') added++;
    else if (line.type === 'remove') removed++;
  }
  return { added, removed };
}
