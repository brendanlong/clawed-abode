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

/**
 * A plan-relevant event extracted from the message stream, in `sequence` order.
 * - `write`/`edit`: a Write/Edit tool call against a plan file
 * - `exit`: an ExitPlanMode tool call (identified by its tool_use id)
 */
export type PlanEvent =
  | { kind: 'write'; sequence: number; filePath: string; content: string }
  | { kind: 'edit'; sequence: number; filePath: string; oldString: string; newString: string }
  | { kind: 'exit'; sequence: number; toolUseId: string };

/**
 * Reconstruct the plan content shown by each ExitPlanMode approval, keyed by the
 * ExitPlanMode tool_use id.
 *
 * A session can contain several plans — revisions to the same file, or entirely
 * separate plan files across multiple plan-mode rounds. So we replay Write/Edit
 * **per file** (a Write resets that file, an Edit replaces within it) and tie
 * each ExitPlanMode to the plan file most recently touched before it. This keeps
 * each approval showing the plan that was actually being approved, instead of a
 * single global "latest plan" leaking backward onto earlier approvals.
 */
export function reconstructPlansByToolUseId(events: PlanEvent[]): Map<string, string> {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const contentByFile = new Map<string, string>();
  const result = new Map<string, string>();
  let lastPlanFile: string | null = null;

  for (const event of sorted) {
    switch (event.kind) {
      case 'write':
        contentByFile.set(event.filePath, event.content);
        lastPlanFile = event.filePath;
        break;
      case 'edit': {
        // `replace` mirrors the Edit tool: first occurrence only. An empty
        // oldString is a no-op (matches the previous behavior's guard).
        const current = contentByFile.get(event.filePath) ?? '';
        contentByFile.set(
          event.filePath,
          event.oldString ? current.replace(event.oldString, event.newString) : current
        );
        lastPlanFile = event.filePath;
        break;
      }
      case 'exit': {
        const content = lastPlanFile ? (contentByFile.get(lastPlanFile) ?? '') : '';
        if (content) result.set(event.toolUseId, content);
        break;
      }
    }
  }

  return result;
}
