/**
 * Utility functions for detecting and handling plan mode files.
 *
 * Plan files are written by Claude during plan mode to a path like:
 *   /home/claudeuser/.claude/projects/<project>/plan.md
 *
 * These files should be rendered as Markdown rather than raw code.
 */

/**
 * Check if a file path looks like a Claude plan file.
 * Plan files live inside .claude/projects/ directories and end with plan.md
 * (or sometimes have other names, but are always .md inside .claude/projects/).
 */
export function isPlanFile(filePath: string): boolean {
  return filePath.includes('.claude/projects/') && filePath.endsWith('.md');
}
