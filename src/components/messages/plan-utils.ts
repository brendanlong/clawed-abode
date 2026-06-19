/**
 * Utility functions for detecting and handling plan mode files.
 *
 * In plan mode Claude writes its plan to a Markdown file, which both the
 * ExitPlanMode approval panel (via reconstructed `latestPlanContent`) and the
 * Write/Edit displays render as Markdown rather than raw code.
 *
 * The SDK defaults this to `~/.claude/plans/<name>.md` (see `plansDirectory` in
 * the SDK options, which defaults to `~/.claude/plans/`). Older versions wrote
 * to `.claude/projects/<project>/plan.md`, which we still recognize.
 */

/** Directory segments that hold Claude plan files. */
const PLAN_DIR_SEGMENTS = ['.claude/plans/', '.claude/projects/'];

/**
 * Check if a file path looks like a Claude plan file: a `.md` file inside a
 * known plan directory.
 */
export function isPlanFile(filePath: string): boolean {
  if (!filePath.endsWith('.md')) return false;
  return PLAN_DIR_SEGMENTS.some((segment) => filePath.includes(segment));
}
