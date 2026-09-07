import type { ZodType } from 'zod';

/**
 * Validate a tool call's `input` against the display's schema. Returns undefined
 * when it doesn't match (an unexpected shape, or a still-streaming call whose
 * input isn't complete), so displays fall back to their placeholders instead of
 * trusting an unchecked cast.
 */
export function parseToolInput<T>(input: unknown, schema: ZodType<T>): T | undefined {
  const parsed = schema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}
