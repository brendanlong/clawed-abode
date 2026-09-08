import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 50;

/**
 * Keyset cursor for lists ordered by (<timestamp field> desc, id desc). The id
 * tiebreaker keeps the order total, so rows sharing a timestamp can never be
 * skipped or repeated across pages.
 */
export const keysetCursorSchema = z.object({
  at: z.iso.datetime(),
  id: z.string(),
});

export type KeysetCursor = z.infer<typeof keysetCursorSchema>;

type OlderThan<F extends string> = { [K in F]: { lt: Date } };
type SameTimestampLowerId<F extends string> = { [K in F]: Date } & { id: { lt: string } };

/** Prisma `where` fragment selecting rows strictly after the cursor in (field desc, id desc) order. */
export function buildKeysetWhere<F extends string>(
  field: F,
  cursor: KeysetCursor | undefined
): { OR: [OlderThan<F>, SameTimestampLowerId<F>] } | Record<never, never> {
  if (!cursor) return {};
  const at = new Date(cursor.at);
  return {
    OR: [
      { [field]: { lt: at } } as OlderThan<F>,
      { [field]: at, id: { lt: cursor.id } } as SameTimestampLowerId<F>,
    ],
  };
}

/**
 * Given `limit + 1` rows fetched in cursor order, return the page and the cursor
 * for the next one (undefined when this was the last page).
 */
export function sliceKeysetPage<F extends string, T extends { id: string } & Record<F, Date>>(
  rows: T[],
  limit: number,
  field: F
): { items: T[]; nextCursor: KeysetCursor | undefined } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last ? { at: last[field].toISOString(), id: last.id } : undefined;
  return { items, nextCursor };
}
