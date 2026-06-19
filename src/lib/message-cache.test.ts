import { describe, it, expect } from 'vitest';
import {
  mergeMessageIntoCache,
  isPartialMessageId,
  PARTIAL_MESSAGE_ID_PREFIX,
  type MessageInfiniteCache,
} from './message-cache';

interface Msg {
  id: string;
  sequence: number;
}

const partial = (uuid: string, seq: number): Msg => ({
  id: `${PARTIAL_MESSAGE_ID_PREFIX}${uuid}`,
  sequence: seq,
});
const complete = (id: string, seq: number): Msg => ({ id, sequence: seq });

function cache(pages: Msg[][]): MessageInfiniteCache<Msg> {
  return {
    pages: pages.map((messages) => ({ messages, hasMore: false })),
    pageParams: pages.map(() => undefined),
  };
}

describe('isPartialMessageId', () => {
  it('detects the partial prefix', () => {
    expect(isPartialMessageId('partial-abc')).toBe(true);
    expect(isPartialMessageId('msg-1')).toBe(false);
  });
});

describe('mergeMessageIntoCache', () => {
  it('bootstraps a page when there is no existing cache', () => {
    const result = mergeMessageIntoCache<Msg>(undefined, complete('a', 0));
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].messages).toEqual([complete('a', 0)]);
  });

  it('bootstraps a page when the cache has zero pages', () => {
    const result = mergeMessageIntoCache(cache([]), complete('a', 0));
    expect(result.pages[0].messages).toEqual([complete('a', 0)]);
  });

  it('appends a partial when none exists on the newest page', () => {
    const result = mergeMessageIntoCache(cache([[complete('a', 0)]]), partial('p', 1));
    expect(result.pages[0].messages).toEqual([complete('a', 0), partial('p', 1)]);
  });

  it('replaces an existing partial instead of appending a second one', () => {
    const result = mergeMessageIntoCache(
      cache([[complete('a', 0), partial('p', 1)]]),
      partial('p', 1)
    );
    const partials = result.pages[0].messages.filter((m) => isPartialMessageId(m.id));
    expect(partials).toHaveLength(1);
  });

  it('only touches the newest page when handling partials', () => {
    const older = [complete('a', 0)];
    const result = mergeMessageIntoCache(cache([[complete('b', 1)], older]), partial('p', 2));
    // page[1] (older) is returned by reference, unchanged
    expect(result.pages[1].messages).toBe(older);
  });

  it('drops partials and appends when a complete message arrives', () => {
    const result = mergeMessageIntoCache(
      cache([[complete('a', 0), partial('p', 1)]]),
      complete('b', 1)
    );
    expect(result.pages[0].messages).toEqual([complete('a', 0), complete('b', 1)]);
  });

  it('dedupes a complete message that is already present', () => {
    const existing = cache([[complete('a', 0)], [complete('b', 1)]]);
    const result = mergeMessageIntoCache(existing, complete('b', 1));
    expect(result).toBe(existing);
  });
});
