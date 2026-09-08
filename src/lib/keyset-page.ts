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

export const keysetPageInputSchema = z.object({
  cursor: keysetCursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
});

type OlderThan<F extends string> = { [K in F]: { lt: Date } };
type SameTimestampLowerId<F extends string> = { [K in F]: Date } & { id: { lt: string } };

/**
 * One page of a (field desc, id desc) keyset list. Naming the field once ties
 * the `where`, `orderBy`, and cursor extraction together so they can't page on
 * one column and sort on another. Spread `where`/`orderBy`/`take` into the
 * Prisma query, then pass the rows to `slice`.
 */
export function keysetPage<F extends string>(
  field: F,
  input: { cursor?: KeysetCursor; limit: number }
) {
  const at = input.cursor ? new Date(input.cursor.at) : undefined;
  const where: { OR: [OlderThan<F>, SameTimestampLowerId<F>] } | Record<never, never> =
    at && input.cursor
      ? {
          OR: [
            { [field]: { lt: at } } as OlderThan<F>,
            { [field]: at, id: { lt: input.cursor.id } } as SameTimestampLowerId<F>,
          ],
        }
      : {};
  return {
    where,
    orderBy: [{ [field]: 'desc' } as { [K in F]: 'desc' }, { id: 'desc' as const }],
    // One extra row tells us whether a next page exists.
    take: input.limit + 1,
    slice<T extends { id: string } & Record<F, Date>>(
      rows: T[]
    ): { items: T[]; nextCursor: KeysetCursor | undefined } {
      const items = rows.slice(0, input.limit);
      const last = items[items.length - 1];
      const nextCursor =
        rows.length > input.limit && last
          ? { at: last[field].toISOString(), id: last.id }
          : undefined;
      return { items, nextCursor };
    },
  };
}
