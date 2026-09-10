/** One editable row in a settings key/value list (MCP headers, MCP env vars). */
export interface KeyValueEntry {
  key: string;
  value: string;
  isSecret: boolean;
}

/** How env/header maps are stored and sent: a value plus whether it's encrypted. */
export type SecretValueMap = Record<string, { value: string; isSecret: boolean }>;

/**
 * Whether a blank submitted value means "keep what's stored" rather than "store
 * the empty string". It only does for a secret that stays secret: the server
 * keys that off the *submitted* `isSecret`, so a row that drops the flag while
 * blank would overwrite the ciphertext with `''`.
 */
export function keepsStoredSecret(
  existing: { isSecret: boolean } | undefined,
  submittedIsSecret: boolean
): boolean {
  return existing?.isSecret === true && submittedIsSecret;
}

export type KeyValueRecordResult =
  { ok: true; record: SecretValueMap } | { ok: false; error: string };

/**
 * Turn edited rows into the map the server takes, rejecting rows that would
 * silently lose data. Blanking a value is never "delete this row" — the row has
 * its own remove button — so it's an error unless it's an unchanged secret.
 */
export function buildKeyValueRecord(
  entries: KeyValueEntry[],
  existing: SecretValueMap | undefined,
  itemLabel: string
): KeyValueRecordResult {
  // A Map, not an object, so a key like `__proto__` is data rather than a
  // prototype write and doesn't read back as a spurious duplicate.
  const record = new Map<string, SecretValueMap[string]>();

  for (const { key, value, isSecret } of entries) {
    // A row added and then left alone is just an abandoned click, not input.
    if (!key && !value) continue;

    if (!key) {
      return { ok: false, error: `Every ${itemLabel} needs a name` };
    }
    if (!value && !keepsStoredSecret(existing?.[key], isSecret)) {
      return { ok: false, error: `The ${itemLabel} "${key}" needs a value` };
    }
    if (record.has(key)) {
      return { ok: false, error: `Duplicate ${itemLabel} "${key}"` };
    }

    record.set(key, { value, isSecret });
  }

  return { ok: true, record: Object.fromEntries(record) };
}
