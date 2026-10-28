import { describe, it, expect } from 'vitest';
import { keysetPage, pinnedKeysetPage } from './keyset-page';

describe('keysetPage', () => {
  const rows = [
    { id: 'c', createdAt: new Date('2024-03-01T00:00:00Z') },
    { id: 'b', createdAt: new Date('2024-02-01T00:00:00Z') },
    { id: 'a', createdAt: new Date('2024-02-01T00:00:00Z') },
  ];

  it('orders by the field then id, and fetches one row past the limit', () => {
    const page = keysetPage('createdAt', { limit: 2 });
    expect(page.where).toEqual({});
    expect(page.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(page.take).toBe(3);
  });

  it('returns a next cursor pointing at the last item when an extra row was fetched', () => {
    const { items, nextCursor } = keysetPage('createdAt', { limit: 2 }).slice(rows);
    expect(items.map((r) => r.id)).toEqual(['c', 'b']);
    expect(nextCursor).toEqual({ at: '2024-02-01T00:00:00.000Z', id: 'b' });
  });

  it('returns no cursor on the last page', () => {
    const page = keysetPage('createdAt', { limit: 3 });
    expect(page.slice(rows).nextCursor).toBeUndefined();
    expect(page.slice([])).toEqual({ items: [], nextCursor: undefined });
  });

  it('selects strictly-older rows, breaking timestamp ties on id', () => {
    const at = new Date('2024-02-01T00:00:00.000Z');
    const page = keysetPage('lastActivityAt', {
      cursor: { at: at.toISOString(), id: 'b' },
      limit: 2,
    });
    expect(page.where).toEqual({
      OR: [{ lastActivityAt: { lt: at } }, { lastActivityAt: at, id: { lt: 'b' } }],
    });
  });
});

describe('pinnedKeysetPage', () => {
  const at = new Date('2024-02-01T00:00:00.000Z');

  it('orders pinned rows first, then by the field and id', () => {
    const page = pinnedKeysetPage('starred', 'lastActivityAt', { limit: 2 });
    expect(page.where).toEqual({});
    expect(page.orderBy).toEqual([{ starred: 'desc' }, { lastActivityAt: 'desc' }, { id: 'desc' }]);
    expect(page.take).toBe(3);
  });

  it('records whether the last item was pinned in the cursor', () => {
    const rows = [
      { id: 'c', starred: true, lastActivityAt: at },
      { id: 'b', starred: false, lastActivityAt: at },
      { id: 'a', starred: false, lastActivityAt: at },
    ];
    const page = pinnedKeysetPage('starred', 'lastActivityAt', { limit: 1 });
    expect(page.slice(rows).nextCursor).toEqual({ at: at.toISOString(), id: 'c', pinned: true });
    const page2 = pinnedKeysetPage('starred', 'lastActivityAt', { limit: 2 });
    expect(page2.slice(rows).nextCursor).toEqual({ at: at.toISOString(), id: 'b', pinned: false });
    expect(pinnedKeysetPage('starred', 'lastActivityAt', { limit: 3 }).slice(rows).nextCursor).toBe(
      undefined
    );
  });

  it('after a pinned cursor, selects older pinned rows and every unpinned row', () => {
    const page = pinnedKeysetPage('starred', 'lastActivityAt', {
      cursor: { at: at.toISOString(), id: 'b', pinned: true },
      limit: 2,
    });
    expect(page.where).toEqual({
      OR: [
        {
          AND: [
            { starred: true },
            { OR: [{ lastActivityAt: { lt: at } }, { lastActivityAt: at, id: { lt: 'b' } }] },
          ],
        },
        { starred: false },
      ],
    });
  });

  it('after an unpinned cursor, selects only older unpinned rows', () => {
    const page = pinnedKeysetPage('starred', 'lastActivityAt', {
      cursor: { at: at.toISOString(), id: 'b', pinned: false },
      limit: 2,
    });
    expect(page.where).toEqual({
      AND: [
        { starred: false },
        { OR: [{ lastActivityAt: { lt: at } }, { lastActivityAt: at, id: { lt: 'b' } }] },
      ],
    });
  });
});
