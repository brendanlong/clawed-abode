import { z } from 'zod';

const DEFAULT_PAGE_SIZE = 50;

/**
 * Keyset cursor for lists ordered by (<timestamp field> desc, id desc). The id
 * tiebreaker keeps the order total, so rows sharing a timestamp can never be
 * skipped or repeated across pages.
 */
const keysetCursorSchema = z.object({
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
  const where: { OR: [OlderThan<F>, SameTimestampLowerId<F>] } | Record<never, never> = input.cursor
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

const pinnedKeysetCursorSchema = keysetCursorSchema.extend({ pinned: z.boolean() });

export type PinnedKeysetCursor = z.infer<typeof pinnedKeysetCursorSchema>;

export const pinnedKeysetPageInputSchema = keysetPageInputSchema.extend({
  cursor: pinnedKeysetCursorSchema.optional(),
});

type Pinned<P extends string> = { [K in P]: boolean };

/**
 * A {@link keysetPage} with pinned rows first: ordered by (<boolean pin field>
 * desc, <timestamp field> desc, id desc), so pinned rows keep their usual order
 * among themselves above every unpinned row.
 */
export function pinnedKeysetPage<P extends string, F extends string>(
  pinField: P,
  field: F,
  input: { cursor?: PinnedKeysetCursor; limit: number }
) {
  const inner = keysetPage(field, input);
  const pinned = (value: boolean) => ({ [pinField]: value }) as Pinned<P>;
  const samePinLater = input.cursor && { AND: [pinned(input.cursor.pinned), inner.where] };
  // Past a pinned cursor, every unpinned row is still to come.
  const where = !samePinLater
    ? {}
    : input.cursor?.pinned
      ? { OR: [samePinLater, pinned(false)] }
      : samePinLater;
  return {
    where,
    orderBy: [{ [pinField]: 'desc' } as { [K in P]: 'desc' }, ...inner.orderBy],
    take: inner.take,
    slice<T extends { id: string } & Record<F, Date> & Pinned<P>>(
      rows: T[]
    ): { items: T[]; nextCursor: PinnedKeysetCursor | undefined } {
      const { items, nextCursor } = inner.slice(rows);
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: nextCursor && last ? { ...nextCursor, pinned: last[pinField] } : undefined,
      };
    },
  };
}
