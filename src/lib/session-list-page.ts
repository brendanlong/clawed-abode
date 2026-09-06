import { z } from 'zod';

export const SESSION_PAGE_SIZE = 50;

/**
 * Keyset cursor for the session list, ordered by (lastActivityAt desc, id desc).
 * The id tiebreaker keeps the order total, so two sessions with the same
 * activity timestamp can never be skipped or repeated across pages.
 */
export const sessionCursorSchema = z.object({
  lastActivityAt: z.string(),
  id: z.string(),
});

export type SessionCursor = z.infer<typeof sessionCursorSchema>;

export function buildSessionCursorWhere(cursor: SessionCursor | undefined) {
  if (!cursor) return {};
  const at = new Date(cursor.lastActivityAt);
  return {
    OR: [{ lastActivityAt: { lt: at } }, { lastActivityAt: at, id: { lt: cursor.id } }],
  };
}

/**
 * Given `limit + 1` rows fetched in cursor order, return the page and the cursor
 * for the next one (undefined when this was the last page).
 */
export function sliceSessionPage<T extends { id: string; lastActivityAt: Date }>(
  rows: T[],
  limit: number
): { items: T[]; nextCursor: SessionCursor | undefined } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? { lastActivityAt: last.lastActivityAt.toISOString(), id: last.id }
      : undefined;
  return { items, nextCursor };
}
