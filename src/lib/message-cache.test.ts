import { describe, it, expect } from 'vitest';
import {
  applyHistorySnapshot,
  mergeMessageIntoCache,
  removeMessageFromCache,
  isPartialMessageId,
  partialMessageId,
  type HistorySnapshot,
  type MessageInfiniteCache,
} from './message-cache';

interface Msg {
  id: string;
  sequence: number;
  type?: string;
  content?: unknown;
}

const partial = (parentToolUseId: string | null, seq: number): Msg => ({
  id: partialMessageId(parentToolUseId),
  sequence: seq,
  type: 'assistant',
});
const complete = (id: string, seq: number): Msg => ({ id, sequence: seq });
const assistant = (id: string, seq: number, parentToolUseId: string | null): Msg => ({
  id,
  sequence: seq,
  type: 'assistant',
  content: { type: 'assistant', parent_tool_use_id: parentToolUseId },
});

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
    const result = mergeMessageIntoCache(cache([[complete('a', 0)]]), partial(null, 1));
    expect(result.pages[0].messages).toEqual([complete('a', 0), partial(null, 1)]);
  });

  it('replaces an existing partial instead of appending a second one', () => {
    const result = mergeMessageIntoCache(
      cache([[complete('a', 0), partial(null, 1)]]),
      partial(null, 1)
    );
    const partials = result.pages[0].messages.filter((m) => isPartialMessageId(m.id));
    expect(partials).toHaveLength(1);
  });

  it('only touches the newest page when handling partials', () => {
    const older = [complete('a', 0)];
    const result = mergeMessageIntoCache(cache([[complete('b', 1)], older]), partial(null, 2));
    // page[1] (older) is returned by reference, unchanged
    expect(result.pages[1].messages).toBe(older);
  });

  it("replaces a complete assistant message's own partial and appends", () => {
    const result = mergeMessageIntoCache(
      cache([[complete('a', 0), partial(null, 1)]]),
      assistant('b', 1, null)
    );
    expect(result.pages[0].messages).toEqual([complete('a', 0), assistant('b', 1, null)]);
  });

  it('keeps one partial per stream when the main agent and a subagent interleave', () => {
    let result = mergeMessageIntoCache(cache([[complete('a', 0)]]), partial(null, 1));
    result = mergeMessageIntoCache(result, partial('task-1', 1));
    result = mergeMessageIntoCache(result, partial(null, 1));
    expect(result.pages[0].messages.map((m) => m.id)).toEqual([
      'a',
      partialMessageId(null),
      partialMessageId('task-1'),
    ]);
  });

  it("a subagent's complete message supersedes only the subagent's partial", () => {
    const result = mergeMessageIntoCache(
      cache([[complete('a', 0), partial(null, 1), partial('task-1', 1)]]),
      assistant('b', 1, 'task-1')
    );
    expect(result.pages[0].messages).toEqual([
      complete('a', 0),
      assistant('b', 1, 'task-1'),
      partial(null, 1),
    ]);
  });

  it('drops the main partial when a user prompt arrives after a stopped stream', () => {
    const result = mergeMessageIntoCache(cache([[complete('a', 0), partial(null, 1)]]), {
      id: 'u',
      sequence: 1,
      type: 'user',
      content: { type: 'user', parent_tool_use_id: null },
    });
    expect(result.pages[0].messages.map((m) => m.id)).toEqual(['a', 'u']);
  });

  it('drops every partial when the query dies with an error', () => {
    const result = mergeMessageIntoCache(
      cache([[complete('a', 0), partial(null, 1), partial('task-1', 1)]]),
      { id: 'e', sequence: 1, type: 'system', content: { type: 'system', subtype: 'error' } }
    );
    expect(result.pages[0].messages.map((m) => m.id)).toEqual(['a', 'e']);
  });

  it('keeps partials after a complete non-assistant message', () => {
    const result = mergeMessageIntoCache(
      cache([[complete('a', 0), partial(null, 1)]]),
      complete('b', 1)
    );
    expect(result.pages[0].messages).toEqual([
      complete('a', 0),
      complete('b', 1),
      partial(null, 1),
    ]);
  });

  it('drops every partial when the turn result arrives', () => {
    const result = mergeMessageIntoCache(
      cache([[complete('a', 0), partial(null, 1), partial('task-1', 1)]]),
      { id: 'r', sequence: 1, type: 'result' }
    );
    expect(result.pages[0].messages).toEqual([
      complete('a', 0),
      { id: 'r', sequence: 1, type: 'result' },
    ]);
  });

  it('inserts a complete message that arrives out of sequence order at its position', () => {
    const result = mergeMessageIntoCache(
      cache([[complete('a', 4), complete('c', 6)], [complete('z', 1)]]),
      complete('b', 5)
    );
    expect(result.pages[0].messages).toEqual([
      complete('a', 4),
      complete('b', 5),
      complete('c', 6),
    ]);
    expect(result.pages[1].messages).toEqual([complete('z', 1)]);
  });

  it('dedupes a complete message that is already present', () => {
    const existing = cache([[complete('a', 0)], [complete('b', 1)]]);
    const result = mergeMessageIntoCache(existing, complete('b', 1));
    expect(result).toBe(existing);
  });

  it('still drops the partial a re-delivered complete message supersedes', () => {
    // A snapshot can carry the complete message before the queued partial that
    // preceded its live event; the re-delivered message must clear that partial.
    const result = mergeMessageIntoCache(
      cache([[assistant('a', 0, null), partial(null, 0)]]),
      assistant('a', 0, null)
    );
    expect(result.pages[0].messages).toEqual([assistant('a', 0, null)]);
  });
});

describe('applyHistorySnapshot', () => {
  const snapshot = (
    after: number,
    messages: Msg[],
    extra: Partial<HistorySnapshot<Msg>> = {}
  ): HistorySnapshot<Msg> => ({ after, messages, hasMore: after >= 0, partials: [], ...extra });

  it('replaces a cache the snapshot doesn’t join, taking its hasMore', () => {
    // An earlier mount's cache that many messages have since passed: a gap.
    const result = applyHistorySnapshot(
      cache([[complete('x', 50)], [complete('w', 10)]]),
      snapshot(89, [complete('a', 90), complete('b', 91)], { hasMore: true })
    );
    expect(result).toEqual({
      pages: [{ messages: [complete('a', 90), complete('b', 91)], hasMore: true }],
      pageParams: [null],
    });
  });

  it('bootstraps from the snapshot when nothing is cached, with the server’s hasMore', () => {
    const result = applyHistorySnapshot<Msg>(
      undefined,
      snapshot(4, [complete('e', 5)], { hasMore: false })
    );
    expect(result).toEqual({
      pages: [{ messages: [complete('e', 5)], hasMore: false }],
      pageParams: [null],
    });
  });

  it('merges into a cache it joins, keeping older pages (the scroll-back)', () => {
    const older = { messages: [complete('a', 0)], hasMore: true };
    const result = applyHistorySnapshot(
      {
        pages: [{ messages: [complete('b', 1), complete('c', 2)], hasMore: true }, older],
        pageParams: [null, 1],
      },
      snapshot(1, [complete('c', 2), complete('d', 3)])
    );
    expect(result).toEqual({
      pages: [
        { messages: [complete('b', 1), complete('c', 2), complete('d', 3)], hasMore: true },
        older,
      ],
      pageParams: [null, 1],
    });
  });

  it('drops cached messages in its range that the server no longer has', () => {
    // A `message_removed` lost while disconnected (or to a buffer overflow).
    const result = applyHistorySnapshot(
      cache([[complete('a', 0), complete('gone', 1), complete('c', 2)]]),
      snapshot(0, [complete('c', 2)])
    );
    expect(result.pages[0].messages).toEqual([complete('a', 0), complete('c', 2)]);
  });

  it('replaces cached rows in its range with its own, in place', () => {
    // E.g. a row marked interrupted while the client was disconnected.
    const updated = { ...complete('b', 1), content: { interrupted: true } };
    const result = applyHistorySnapshot(
      cache([[complete('b', 1)], [complete('a', 0)]]),
      snapshot(0, [updated])
    );
    expect(result.pages.map((p) => p.messages)).toEqual([[updated], [complete('a', 0)]]);
  });

  it('replaces the cached partials with the snapshot’s', () => {
    const live = { ...partial('tool-1', 1), content: { text: 'now' } };
    const result = applyHistorySnapshot(
      cache([[complete('a', 0), partial(null, 1)]]),
      snapshot(-1, [complete('a', 0)], { partials: [live] })
    );
    expect(result.pages[0].messages).toEqual([complete('a', 0), live]);
  });
});

describe('removeMessageFromCache', () => {
  it('drops the message from whichever page holds it', () => {
    const result = removeMessageFromCache(
      cache([[complete('b', 1), complete('c', 2)], [complete('a', 0)]]),
      'c'
    );
    expect(result!.pages[0].messages).toEqual([complete('b', 1)]);
    expect(result!.pages[1].messages).toEqual([complete('a', 0)]);
  });

  it('returns the same reference when the id is absent', () => {
    const existing = cache([[complete('a', 0)]]);
    expect(removeMessageFromCache(existing, 'nope')).toBe(existing);
  });

  it('handles an empty cache', () => {
    expect(removeMessageFromCache(undefined, 'a')).toBeUndefined();
  });
});
