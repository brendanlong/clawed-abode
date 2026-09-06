import { describe, it, expect } from 'vitest';
import { buildSessionCursorWhere, sliceSessionPage } from './session-list-page';

describe('sliceSessionPage', () => {
  const rows = [
    { id: 'c', lastActivityAt: new Date('2024-03-01T00:00:00Z') },
    { id: 'b', lastActivityAt: new Date('2024-02-01T00:00:00Z') },
    { id: 'a', lastActivityAt: new Date('2024-02-01T00:00:00Z') },
  ];

  it('returns a next cursor pointing at the last item when an extra row was fetched', () => {
    const { items, nextCursor } = sliceSessionPage(rows, 2);
    expect(items.map((r) => r.id)).toEqual(['c', 'b']);
    expect(nextCursor).toEqual({ lastActivityAt: '2024-02-01T00:00:00.000Z', id: 'b' });
  });

  it('returns no cursor on the last page', () => {
    expect(sliceSessionPage(rows, 3).nextCursor).toBeUndefined();
    expect(sliceSessionPage([], 3)).toEqual({ items: [], nextCursor: undefined });
  });
});

describe('buildSessionCursorWhere', () => {
  it('is empty without a cursor', () => {
    expect(buildSessionCursorWhere(undefined)).toEqual({});
  });

  it('selects strictly-older rows, breaking timestamp ties on id', () => {
    const at = new Date('2024-02-01T00:00:00.000Z');
    expect(buildSessionCursorWhere({ lastActivityAt: at.toISOString(), id: 'b' })).toEqual({
      OR: [{ lastActivityAt: { lt: at } }, { lastActivityAt: at, id: { lt: 'b' } }],
    });
  });
});
