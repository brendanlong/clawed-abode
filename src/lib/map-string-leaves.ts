/**
 * Rebuild a JSON-ish value with every string leaf replaced by `fn(leaf)`,
 * preserving structure. Object keys are structural and left untouched.
 */
export async function mapStringLeaves(
  value: unknown,
  fn: (text: string) => Promise<string>
): Promise<unknown> {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return Promise.all(value.map((item) => mapStringLeaves(item, fn)));
  if (value !== null && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, item]) => [key, await mapStringLeaves(item, fn)])
    );
    return Object.fromEntries(entries);
  }
  return value;
}
