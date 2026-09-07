/**
 * Pure helpers for merging live SSE messages into the React Query infinite-query
 * cache used by the session message list.
 *
 * Two kinds of messages arrive over the stream:
 * - **Partial** messages (id prefixed with {@link PARTIAL_MESSAGE_ID_PREFIX}) are
 *   transient streaming snapshots of the in-progress assistant turn. At most one
 *   lives in the cache at a time; each new one replaces it.
 * - **Complete** messages are persisted. When one arrives it removes any lingering
 *   partials and is inserted by `sequence`, deduped by id — a re-delivered id is
 *   ignored rather than merged, so the cache never reconciles an edit. The one way
 *   a complete message leaves is {@link removeMessageFromCache}, when the server
 *   deletes the row outright.
 *
 * page[0] holds the newest messages (matching `getHistory`'s backward pagination),
 * so live messages land in page[0]. Inserting by sequence (not arrival order)
 * keeps every page chronological even if the server emits two concurrently
 * persisted messages out of order; the message list relies on that ordering
 * instead of re-sorting.
 */

/** Prefix for transient streaming (partial) message ids. */
export const PARTIAL_MESSAGE_ID_PREFIX = 'partial-';

export function isPartialMessageId(id: string): boolean {
  return id.startsWith(PARTIAL_MESSAGE_ID_PREFIX);
}

export interface MessageLike {
  id: string;
  sequence: number;
}

interface MessagePage<M extends MessageLike> {
  messages: M[];
  hasMore: boolean;
}

export interface MessageInfiniteCache<M extends MessageLike, P = unknown> {
  pages: MessagePage<M>[];
  pageParams: P[];
}

/**
 * Merge a single live message into the infinite-query cache. Pure: returns a new
 * cache object (or the same reference when nothing changes, e.g. a duplicate).
 */
export function mergeMessageIntoCache<M extends MessageLike, P = unknown>(
  old: MessageInfiniteCache<M, P> | undefined,
  message: M
): MessageInfiniteCache<M, P> {
  const isPartial = isPartialMessageId(message.id);

  if (!old || old.pages.length === 0) {
    // No existing data - bootstrap a single page.
    return {
      pages: [{ messages: [message], hasMore: false }],
      pageParams: [{ direction: 'backward' as const, sequence: undefined }] as unknown as P[],
    };
  }

  if (isPartial) {
    // Replace the existing partial on the newest page, or append if none exists.
    const newPages = old.pages.map((page, pageIndex) => {
      if (pageIndex !== 0) return page;
      const hasExistingPartial = page.messages.some((m) => isPartialMessageId(m.id));
      if (hasExistingPartial) {
        return {
          ...page,
          messages: page.messages.map((m) => (isPartialMessageId(m.id) ? message : m)),
        };
      }
      return { ...page, messages: [...page.messages, message] };
    });
    return { ...old, pages: newPages };
  }

  // Complete message: dedupe by id across all pages first.
  for (const page of old.pages) {
    if (page.messages.some((m) => m.id === message.id)) {
      return old;
    }
  }

  // Drop any partials from the newest page (they are now superseded) and insert
  // at the sequence position. Scans from the end: the common case is an append.
  const newPages = [...old.pages];
  const firstPageMessages = newPages[0].messages.filter((m) => !isPartialMessageId(m.id));
  let insertAt = firstPageMessages.length;
  while (insertAt > 0 && firstPageMessages[insertAt - 1].sequence > message.sequence) {
    insertAt--;
  }
  firstPageMessages.splice(insertAt, 0, message);
  newPages[0] = { ...newPages[0], messages: firstPageMessages };
  return { ...old, pages: newPages };
}

/**
 * Drop a message from the cache by id. Used when the server deletes a row the
 * transcript should no longer claim happened — a prompt cancelled by Stop before
 * the agent ever read it. Pure: returns the same reference when the id is absent.
 */
export function removeMessageFromCache<M extends MessageLike, P = unknown>(
  old: MessageInfiniteCache<M, P> | undefined,
  messageId: string
): MessageInfiniteCache<M, P> | undefined {
  if (!old) return old;
  if (!old.pages.some((page) => page.messages.some((m) => m.id === messageId))) return old;
  return {
    ...old,
    pages: old.pages.map((page) => ({
      ...page,
      messages: page.messages.filter((m) => m.id !== messageId),
    })),
  };
}
