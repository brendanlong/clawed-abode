import { z } from 'zod';

/**
 * Findings from the input sanitizer (`agent-sanitizer`), persisted on the
 * affected message so the UI can surface a visible "hidden content was filtered"
 * indicator on the exact message/tool result it applied to.
 *
 * - `found`: the library's detected categories (e.g. cf-format, ansi,
 *   html-comments, hidden-html, exfil-urls, confusable-host). These render raw
 *   in the badge when no message accompanies them, so they are user-visible.
 * - `warnings`: its human-readable messages, merged from both of the library's
 *   severity tiers (see `collectMessages` in the input sanitizer) and including
 *   the hex-dump recovery pointer for stripped bytes.
 * - `removed`: true when a string was actually rewritten. Exfil-shaped URLs and
 *   look-alike host names are *detected and reported* but deliberately left in
 *   place by the library, so a finding can be advisory-only (`removed: false`).
 *
 * Kept dependency-free (schema + pure helpers) so the server writer and the client
 * renderer share one source of truth.
 */
const SanitizationInfoSchema = z.object({
  found: z.array(z.string()),
  warnings: z.array(z.string()),
  removed: z.boolean(),
});
export type SanitizationInfo = z.infer<typeof SanitizationInfoSchema>;

/**
 * How much of the library's finding text we are willing to carry. Its messages
 * name every string they flag, so length scales with a count whoever wrote the
 * scanned text controls: 1000 look-alike host names on one page produce a single
 * ~63k-character sentence enumerating all of them. Every consumer of that text
 * is a place a hostile page could otherwise spend someone's budget — the model's
 * context, a SQLite row, an SSE frame — so they share one bound. Generous enough
 * that every realistic multi-finding message passes through whole.
 */
export const FINDING_TEXT_BUDGET = 2000;

/**
 * Cut the library's finding text down to {@link FINDING_TEXT_BUDGET}. Callers
 * word their own truncation marker, because the two readers need different
 * things said: the model has to be told the standing instruction it just lost
 * (the library places its "do not fetch these" clause *after* the enumeration),
 * while the operator only needs to know the list was cut.
 */
export function capFindingText(text: string): { text: string; truncated: boolean } {
  if (text.length <= FINDING_TEXT_BUDGET) return { text, truncated: false };
  return { text: text.slice(0, FINDING_TEXT_BUDGET), truncated: true };
}

/**
 * Build a {@link SanitizationInfo} from a sanitizer result, or `null` when there
 * is nothing to surface (no categories were detected). `removed` records whether
 * any string actually changed vs. an advisory-only detection.
 *
 * Over-budget text collapses to a single capped entry: past a couple of thousand
 * characters the badge popover is unreadable anyway, so the only thing lost is
 * an enumeration nobody was going to finish.
 */
export function buildSanitizationInfo(
  found: string[],
  messages: string[],
  removed: boolean
): SanitizationInfo | null {
  if (found.length === 0) return null;
  const capped = capFindingText(messages.join(' '));
  return {
    found,
    warnings: capped.truncated ? [`${capped.text}… [truncated]`] : messages,
    removed,
  };
}

/**
 * Parse a possibly-present `sanitization` field off a stored message's JSON
 * content. Returns `null` when absent, malformed, or empty (older messages, or a
 * shape we don't recognize) so rendering can no-op safely.
 */
export function parseSanitizationInfo(value: unknown): SanitizationInfo | null {
  const parsed = SanitizationInfoSchema.safeParse(value);
  if (!parsed.success || parsed.data.found.length === 0) return null;
  return parsed.data;
}
