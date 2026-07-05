import type { SanitizationInfo } from './sanitization';

/**
 * Attach sanitizer findings to the `tool_result` blocks of a persisted user
 * message, correlating by `tool_use_id`. The findings are produced by the
 * PostToolUse hook (which sees the raw tool output) but the message they belong
 * to arrives later from the SDK stream, so we stitch them together here just
 * before persisting.
 *
 * Mutates the message content in place (it is about to be serialized to the DB)
 * and consumes matched entries from `sanitizations` so each is attached once.
 * Tolerant of any message shape — a non-tool_result user message (e.g. a plain
 * prompt echo) simply matches nothing.
 */
export function attachToolResultSanitizations(
  message: unknown,
  sanitizations: Map<string, SanitizationInfo>
): void {
  if (sanitizations.size === 0) return;
  if (!message || typeof message !== 'object') return;

  const inner = (message as { message?: { content?: unknown } }).message;
  const blocks = inner?.content;
  if (!Array.isArray(blocks)) return;

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const typed = block as {
      type?: unknown;
      tool_use_id?: unknown;
      sanitization?: SanitizationInfo;
    };
    if (typed.type !== 'tool_result' || typeof typed.tool_use_id !== 'string') continue;

    const info = sanitizations.get(typed.tool_use_id);
    if (!info) continue;
    typed.sanitization = info;
    sanitizations.delete(typed.tool_use_id);
  }
}
