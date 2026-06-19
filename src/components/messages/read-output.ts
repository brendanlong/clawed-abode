/** Result of parsing Read tool output into plain code. */
export interface ParsedReadOutput {
  /** File content with line-number prefixes removed, ready for highlighting. */
  code: string;
  /** Number of content lines (for a summary badge). */
  lineCount: number;
}

// Leading line-number prefix in Read output: optional spaces, digits, then a
// separator. Handles both the arrow style ("   12→code") and cat -n tabs
// ("   12\tcode"). Only the first separator is consumed, so tab/arrow
// characters within the content itself are preserved.
const LINE_PREFIX = /^\s*\d+[→\t]/;
const SYSTEM_REMINDER = /<\/?system-reminder>/;

/**
 * Parse Read tool output into plain file content, stripping the line-number
 * gutter that Read prepends to each line and dropping any injected
 * system-reminder lines. Returns the de-numbered code and a line count.
 * Pure function: same input → same output.
 */
export function parseReadOutput(output: unknown): ParsedReadOutput {
  if (typeof output !== 'string' || output === '') {
    return { code: '', lineCount: 0 };
  }

  let lines = output.split('\n').filter((line) => !SYSTEM_REMINDER.test(line));

  // Drop a single trailing empty line produced by a terminating newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1);
  }

  // Only strip prefixes if this actually looks like numbered Read output —
  // detected from the first non-empty line. Otherwise raw content that happens
  // to start a line with "<number><tab>" would be corrupted.
  const firstNonEmpty = lines.find((line) => line.trim() !== '');
  const hasPrefix = firstNonEmpty !== undefined && LINE_PREFIX.test(firstNonEmpty);
  const stripped = hasPrefix ? lines.map((line) => line.replace(LINE_PREFIX, '')) : lines;

  return { code: stripped.join('\n'), lineCount: stripped.length };
}
