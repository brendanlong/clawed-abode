import { z, type ZodType } from 'zod';

/**
 * An optional field that degrades to `undefined` on a wrong-typed value instead
 * of failing the whole input, so one odd field (a stringified number, say) only
 * blanks its own placeholder and the rest of the display still renders.
 */
export function lenient<T>(schema: ZodType<T>) {
  return schema.optional().catch(undefined);
}

/** A string field that degrades to '' when missing or wrong-typed. */
export const lenientString = z.string().catch('');

/**
 * Validate a tool call's `input` against the display's schema. Returns undefined
 * when it isn't an object at all (or a still-streaming call whose input isn't
 * complete), so displays fall back to their placeholders instead of trusting an
 * unchecked cast.
 */
export function parseToolInput<T>(input: unknown, schema: ZodType<T>): T | undefined {
  const parsed = schema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}
