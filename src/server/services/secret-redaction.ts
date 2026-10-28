import { lintSource } from '@secretlint/core';
import { creator as recommendedRules } from '@secretlint/secretlint-rule-preset-recommend';
import type { SecretLintCoreConfig } from '@secretlint/types';
import { mapStringLeaves } from '@/lib/map-string-leaves';

// The recommended preset only matches keys with a provider-specific shape
// (`sk-ant-`, `ghp_`, `AKIA…`, PEM blocks with a base64 body, …). Generic
// "high-entropy string" rules flag hashes and base64 blobs, so we don't use any.
const CONFIG: SecretLintCoreConfig = {
  rules: [{ id: recommendedRules.meta.id, rule: recommendedRules }],
};
const RULE_ID_PREFIX = '@secretlint/secretlint-rule-';

function shortRuleId(ruleId: string): string {
  return ruleId.startsWith(RULE_ID_PREFIX) ? ruleId.slice(RULE_ID_PREFIX.length) : ruleId;
}

/**
 * Replace each secret in `text` with `[REDACTED:<rule-id>]` — the same marker
 * the transcript scrubber uses, so a reader can tell something was removed and
 * which rule matched. Only the matched range is replaced, never every
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
    // Overlapping matches (e.g. a URL with credentials that is also a database
    // connection string) collapse into the first marker.
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
