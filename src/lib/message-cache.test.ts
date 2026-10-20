import { describe, it, expect } from 'vitest';
import {
  applyHistorySnapshot,
  mergeMessageIntoCache,
  olderPageCursor,
  prependOlderPage,
  removeMessageFromCache,
  isPartialMessageId,
  partialMessageId,
  type HistorySnapshot,
  type TranscriptCache,
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

const cache = (messages: Msg[], hasMore = false): TranscriptCache<Msg> => ({ messages, hasMore });

describe('isPartialMessageId', () => {
  it('detects the partial prefix', () => {
    expect(isPartialMessageId('partial-abc')).toBe(true);
    expect(isPartialMessageId('msg-1')).toBe(false);
  });
});

describe('mergeMessageIntoCache', () => {
  it('bootstraps a cache when there is none', () => {
    expect(mergeMessageIntoCache<Msg>(undefined, complete('a', 0))).toEqual(
      cache([complete('a', 0)])
    );
  });

  it('appends a partial when none exists', () => {
    const result = mergeMessageIntoCache(cache([complete('a', 0)]), partial(null, 1));
    expect(result.messages).toEqual([complete('a', 0), partial(null, 1)]);
  });

  it('replaces an existing partial instead of appending a second one', () => {
    const result = mergeMessageIntoCache(
      cache([complete('a', 0), partial(null, 1)]),
      partial(null, 1)
    );
    expect(result.messages.filter((m) => isPartialMessageId(m.id))).toHaveLength(1);
  });

  it('keeps hasMore', () => {
    const result = mergeMessageIntoCache(cache([complete('a', 0)], true), complete('b', 1));
    expect(result.hasMore).toBe(true);
  });

  it("replaces a complete assistant message's own partial and appends", () => {
    const result = mergeMessageIntoCache(
      cache([complete('a', 0), partial(null, 1)]),
      assistant('b', 1, null)
    );
    expect(result.messages).toEqual([complete('a', 0), assistant('b', 1, null)]);
  });

  it('keeps one partial per stream when the main agent and a subagent interleave', () => {
    let result = mergeMessageIntoCache(cache([complete('a', 0)]), partial(null, 1));
    result = mergeMessageIntoCache(result, partial('task-1', 1));
    result = mergeMessageIntoCache(result, partial(null, 1));
    expect(result.messages.map((m) => m.id)).toEqual([
      'a',
      partialMessageId(null),
      partialMessageId('task-1'),
    ]);
  });

  it("a subagent's complete message supersedes only the subagent's partial", () => {
    const result = mergeMessageIntoCache(
      cache([complete('a', 0), partial(null, 1), partial('task-1', 1)]),
      assistant('b', 1, 'task-1')
    );
    expect(result.messages).toEqual([
      complete('a', 0),
      assistant('b', 1, 'task-1'),
      partial(null, 1),
    ]);
  });

  it('drops the main partial when a user prompt arrives after a stopped stream', () => {
    const result = mergeMessageIntoCache(cache([complete('a', 0), partial(null, 1)]), {
      id: 'u',
      sequence: 1,
      type: 'user',
      content: { type: 'user', parent_tool_use_id: null },
    });
    expect(result.messages.map((m) => m.id)).toEqual(['a', 'u']);
  });

  it('drops every partial when the query dies with an error', () => {
    const result = mergeMessageIntoCache(
      cache([complete('a', 0), partial(null, 1), partial('task-1', 1)]),
      { id: 'e', sequence: 1, type: 'system', content: { type: 'system', subtype: 'error' } }
    );
    expect(result.messages.map((m) => m.id)).toEqual(['a', 'e']);
  });

  it('keeps partials after a complete non-assistant message', () => {
    const result = mergeMessageIntoCache(
      cache([complete('a', 0), partial(null, 1)]),
      complete('b', 1)
    );
    expect(result.messages).toEqual([complete('a', 0), complete('b', 1), partial(null, 1)]);
  });

  it('drops every partial when the turn result arrives', () => {
    const result = mergeMessageIntoCache(
      cache([complete('a', 0), partial(null, 1), partial('task-1', 1)]),
      { id: 'r', sequence: 1, type: 'result' }
    );
    expect(result.messages).toEqual([complete('a', 0), { id: 'r', sequence: 1, type: 'result' }]);
  });

  it('inserts a complete message that arrives out of sequence order at its position', () => {
    const result = mergeMessageIntoCache(
      cache([complete('z', 1), complete('a', 4), complete('c', 6)]),
      complete('b', 5)
    );
    expect(result.messages).toEqual([
      complete('z', 1),
      complete('a', 4),
      complete('b', 5),
      complete('c', 6),
    ]);
  });

  it('dedupes a complete message that is already present', () => {
    const existing = cache([complete('a', 0), complete('b', 1)]);
    expect(mergeMessageIntoCache(existing, complete('a', 0))).toBe(existing);
  });

  it('still drops the partial a re-delivered complete message supersedes', () => {
    // A snapshot can carry the complete message before the queued partial that
    // preceded its live event; the re-delivered message must clear that partial.
    const result = mergeMessageIntoCache(
      cache([assistant('a', 0, null), partial(null, 0)]),
      assistant('a', 0, null)
    );
    expect(result.messages).toEqual([assistant('a', 0, null)]);
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
      cache([complete('w', 10), complete('x', 50)], false),
      snapshot(89, [complete('a', 90), complete('b', 91)], { hasMore: true })
    );
    expect(result).toEqual(cache([complete('a', 90), complete('b', 91)], true));
  });

  it('bootstraps from the snapshot when nothing is cached, with the server’s hasMore', () => {
    const result = applyHistorySnapshot<Msg>(
      undefined,
      snapshot(4, [complete('e', 5)], { hasMore: false })
    );
    expect(result).toEqual(cache([complete('e', 5)], false));
  });

  it('merges into a cache it joins, keeping older messages (the scroll-back) and hasMore', () => {
    const result = applyHistorySnapshot(
      cache([complete('a', 0), complete('b', 1), complete('c', 2)], true),
      snapshot(1, [complete('c', 2), complete('d', 3)], { hasMore: false })
    );
    expect(result).toEqual(
      cache([complete('a', 0), complete('b', 1), complete('c', 2), complete('d', 3)], true)
    );
  });

  it('takes its hasMore when it reaches back past everything cached', () => {
    // Widened to a running background task's spawn, older than the cached page.
    const result = applyHistorySnapshot(
      cache([complete('c', 5), complete('d', 6)], true),
      snapshot(-1, [complete('a', 0), complete('c', 5), complete('d', 6)], { hasMore: false })
    );
    expect(result).toEqual(cache([complete('a', 0), complete('c', 5), complete('d', 6)], false));
  });

  it('drops cached messages in its range that the server no longer has', () => {
    // A `message_removed` lost while disconnected (or to a buffer overflow).
    const result = applyHistorySnapshot(
      cache([complete('a', 0), complete('gone', 1), complete('c', 2)]),
      snapshot(0, [complete('c', 2)])
    );
    expect(result.messages).toEqual([complete('a', 0), complete('c', 2)]);
  });

  it('replaces cached rows in its range with its own', () => {
    // E.g. a row marked interrupted while the client was disconnected.
    const updated = { ...complete('b', 1), content: { interrupted: true } };
    const result = applyHistorySnapshot(
      cache([complete('a', 0), complete('b', 1)]),
      snapshot(0, [updated])
    );
    expect(result.messages).toEqual([complete('a', 0), updated]);
  });

  it('replaces the cached partials with the snapshot’s', () => {
    const live = { ...partial('tool-1', 1), content: { text: 'now' } };
    const result = applyHistorySnapshot(
      cache([complete('a', 0), partial(null, 1)]),
      snapshot(-1, [complete('a', 0)], { partials: [live] })
    );
    expect(result.messages).toEqual([complete('a', 0), live]);
  });
});

describe('removeMessageFromCache', () => {
  it('drops the message', () => {
    const result = removeMessageFromCache(
      cache([complete('a', 0), complete('b', 1), complete('c', 2)]),
      'b'
    );
    expect(result?.messages).toEqual([complete('a', 0), complete('c', 2)]);
  });

  it('returns the same reference when the id is absent', () => {
    const existing = cache([complete('a', 0)]);
    expect(removeMessageFromCache(existing, 'nope')).toBe(existing);
  });

  it('handles an empty cache', () => {
    expect(removeMessageFromCache(undefined, 'a')).toBeUndefined();
  });
});

describe('olderPageCursor', () => {
  it('is the oldest complete message’s sequence when there is more', () => {
    expect(olderPageCursor(cache([complete('a', 4), complete('b', 5)], true))).toBe(4);
  });

  it('is undefined when there is nothing older, or nothing cached', () => {
    expect(olderPageCursor(cache([complete('a', 4)], false))).toBeUndefined();
    expect(olderPageCursor<Msg>(undefined)).toBeUndefined();
  });

  it('ignores partials', () => {
    expect(olderPageCursor(cache([partial(null, 0)], true))).toBeUndefined();
  });
});

describe('prependOlderPage', () => {
  const page = cache([complete('a', 1), complete('b', 2)], false);

  it('prepends a page fetched from the cache’s cursor, taking its hasMore', () => {
    const result = prependOlderPage(cache([complete('c', 3)], true), 3, page);
    expect(result).toEqual(cache([complete('a', 1), complete('b', 2), complete('c', 3)], false));
  });

  it('keeps live writes that landed while the page loaded', () => {
    // The page was requested with cursor 3; a live message and a partial came in since.
    let current = cache([complete('c', 3)], true);
    current = mergeMessageIntoCache(current, complete('d', 4));
    current = mergeMessageIntoCache(current, partial(null, 5));
    expect(prependOlderPage(current, 3, page)?.messages).toEqual([
      complete('a', 1),
      complete('b', 2),
      complete('c', 3),
      complete('d', 4),
      partial(null, 5),
    ]);
  });

  it('drops a page that no longer joins the cache', () => {
    // A snapshot replaced the cache while the page loaded.
    const replaced = cache([complete('x', 90)], true);
    expect(prependOlderPage(replaced, 3, page)).toBe(replaced);
  });

  it('drops a second load of the same page', () => {
    const once = prependOlderPage(cache([complete('c', 3)], true), 3, cache(page.messages, true));
    expect(prependOlderPage(once, 3, page)).toBe(once);
  });
});
