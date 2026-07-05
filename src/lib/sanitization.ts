import { z } from 'zod';

/**
 * Findings from the input sanitizer (`agent-input-sanitizer`), persisted on the
 * affected message so the UI can surface a visible "hidden content was filtered"
 * indicator on the exact message/tool result it applied to.
 *
 * - `found`: the library's detected categories (e.g. invisible-unicode, ansi,
 *   html-comment, exfil-url).
 * - `warnings`: its human-readable notes, including the hex-dump recovery pointer
 *   for stripped bytes.
 * - `removed`: true when a string was actually rewritten. Exfil-shaped URLs are
 *   *detected and reported* but deliberately left in place by the library, so a
 *   finding can be advisory-only (`removed: false`).
 *
 * Kept dependency-free (schema + pure helpers) so the server writer and the client
 * renderer share one source of truth.
 */
export const SanitizationInfoSchema = z.object({
  found: z.array(z.string()),
  warnings: z.array(z.string()),
  removed: z.boolean(),
});
export type SanitizationInfo = z.infer<typeof SanitizationInfoSchema>;

/**
 * Build a {@link SanitizationInfo} from a sanitizer result, or `null` when there
 * is nothing to surface (no categories were detected). `removed` records whether
 * any string actually changed vs. an advisory-only detection.
 */
export function buildSanitizationInfo(
  found: string[],
  warnings: string[],
  removed: boolean
): SanitizationInfo | null {
  if (found.length === 0) return null;
  return { found, warnings, removed };
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
