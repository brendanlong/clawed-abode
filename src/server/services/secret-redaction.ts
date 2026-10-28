import { lintSource } from '@secretlint/core';
import { secretLintProfiler } from '@secretlint/profiler';
import { rules as recommendedRules } from '@secretlint/secretlint-rule-preset-recommend';
import type { SecretLintCoreConfig } from '@secretlint/types';
import { mapStringLeaves } from '@/lib/map-string-leaves';

// Skipped rules:
// - filter-comments lets any text containing `secretlint-disable` switch off
//   redaction for the rest of it; that's meant for source files, not tool output.
// - basicauth and database-connection-string match any URL with a password. In
//   our stored transcripts nearly every match was a placeholder
//   (`user:pass@example.com`, `<password>`) in URL-handling code, and the one
//   real token inside a URL was also caught by its provider rule.
const SKIPPED_RULES = new Set([
  '@secretlint/secretlint-rule-filter-comments',
  '@secretlint/secretlint-rule-basicauth',
  '@secretlint/secretlint-rule-database-connection-string',
]);
const CONFIG: SecretLintCoreConfig = {
  rules: recommendedRules
    .filter((rule) => !SKIPPED_RULES.has(rule.meta.id))
    .map((rule) => ({ id: rule.meta.id, rule })),
};
// On by default, the profiler keeps a performance entry for every lint forever,
// which ran a backfill out of heap after ~1M messages.
secretLintProfiler.setEnabled(false);

const RULE_ID_PREFIX = '@secretlint/secretlint-rule-';

function shortRuleId(ruleId: string): string {
  return ruleId.startsWith(RULE_ID_PREFIX) ? ruleId.slice(RULE_ID_PREFIX.length) : ruleId;
}

/**
 * Replace each secret in `text` with `[REDACTED:<rule-id>]`, so a reader can
 * tell something was removed and which rule matched. Only the matched range is replaced, never every
 * occurrence of the matched string.
 */
export async function redactSecrets(text: string): Promise<{ text: string; rules: string[] }> {
  const { messages } = await lintSource({
    source: { content: text, filePath: 'message.txt', ext: '.txt', contentType: 'text' },
    options: { config: CONFIG, noPhysicFilePath: true },
  });
  if (messages.length === 0) return { text, rules: [] };

  const matches = [...messages].sort((a, b) => a.range[0] - b.range[0]);
  const rules = new Set<string>();
  let result = '';
  let cursor = 0;
  for (const { range, ruleId } of matches) {
    const [start, end] = range;
    // A match inside an earlier one is already gone; one that only overlaps it
    // redacts the rest.
    if (end <= cursor) continue;
    const rule = shortRuleId(ruleId);
    rules.add(rule);
    result += text.slice(cursor, Math.max(start, cursor)) + `[REDACTED:${rule}]`;
    cursor = end;
  }
  return { text: result + text.slice(cursor), rules: [...rules] };
}

/**
 * Redact every string leaf of a JSON-ish value. Works on decoded strings rather
 * than serialized JSON so a match can never swallow part of an escape sequence.
 */
export async function redactSecretsDeep<T>(value: T): Promise<{ value: T; rules: string[] }> {
  const rules = new Set<string>();
  const redacted = await mapStringLeaves(value, async (leaf) => {
    const result = await redactSecrets(leaf);
    for (const rule of result.rules) rules.add(rule);
    return result.text;
  });
  if (rules.size === 0) return { value, rules: [] };
  // mapStringLeaves preserves shape, so the result has the input's type.
  return { value: redacted as T, rules: [...rules] };
}
