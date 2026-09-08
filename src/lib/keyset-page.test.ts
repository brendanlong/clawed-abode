import { describe, it, expect } from 'vitest';
import { buildKeysetWhere, sliceKeysetPage } from './keyset-page';

describe('sliceKeysetPage', () => {
  const rows = [
    { id: 'c', createdAt: new Date('2024-03-01T00:00:00Z') },
    { id: 'b', createdAt: new Date('2024-02-01T00:00:00Z') },
    { id: 'a', createdAt: new Date('2024-02-01T00:00:00Z') },
  ];

  it('returns a next cursor pointing at the last item when an extra row was fetched', () => {
    const { items, nextCursor } = sliceKeysetPage(rows, 2, 'createdAt');
    expect(items.map((r) => r.id)).toEqual(['c', 'b']);
    expect(nextCursor).toEqual({ at: '2024-02-01T00:00:00.000Z', id: 'b' });
  });

  it('returns no cursor on the last page', () => {
    expect(sliceKeysetPage(rows, 3, 'createdAt').nextCursor).toBeUndefined();
    expect(sliceKeysetPage([], 3, 'createdAt')).toEqual({ items: [], nextCursor: undefined });
  });
});

describe('buildKeysetWhere', () => {
  it('is empty without a cursor', () => {
    expect(buildKeysetWhere('createdAt', undefined)).toEqual({});
  });

  it('selects strictly-older rows, breaking timestamp ties on id', () => {
    const at = new Date('2024-02-01T00:00:00.000Z');
    expect(buildKeysetWhere('lastActivityAt', { at: at.toISOString(), id: 'b' })).toEqual({
      OR: [{ lastActivityAt: { lt: at } }, { lastActivityAt: at, id: { lt: 'b' } }],
    });
  });
});
