/**
 * Pure helpers for merging live SSE messages into the React Query infinite-query
 * cache used by the session message list.
 *
 * Two kinds of messages arrive over the stream:
 * - **Partial** messages (id from {@link partialMessageId}) are transient streaming
 *   snapshots of an in-progress assistant message. The main agent and each subagent
 *   stream concurrently, so there is one partial per stream, keyed by
 *   `parent_tool_use_id`; each new snapshot replaces its stream's previous one. They
 *   sit after the complete messages on the newest page.
 * - **Complete** messages are persisted. An assistant or user message supersedes
 *   its own stream's partial; a turn `result` or an error supersedes them all (a
 *   stream cut off by an interrupt, crash, or stop never completes). It is
 *   inserted by `sequence`, deduped by id — a re-delivered id is not merged, so
 *   the cache never reconciles an edit, but it still supersedes partials (a
 *   snapshot can deliver a message ahead of the partials that preceded its live
 *   event). A complete message leaves through {@link removeMessageFromCache}, when
 *   the server deletes the row outright, or {@link applyHistorySnapshot}.
 *
 * page[0] holds the newest messages (matching `getHistory`'s backward pagination),
 * so live messages land in page[0]. Inserting by sequence (not arrival order)
 * keeps every page chronological even if the server emits two concurrently
 * persisted messages out of order; the message list relies on that ordering
 * instead of re-sorting.
 */

import { getParentToolUseId } from './claude-messages';

/** Messages per history page: the stream snapshot's newest page and each backward `getHistory` page. */
export const HISTORY_PAGE_SIZE = 20;

/** Prefix for transient streaming (partial) message ids. */
export const PARTIAL_MESSAGE_ID_PREFIX = 'partial-';

export function isPartialMessageId(id: string): boolean {
  return id.startsWith(PARTIAL_MESSAGE_ID_PREFIX);
}

/** The id of the one live partial for the main agent (`null`) or a subagent. */
export function partialMessageId(parentToolUseId: string | null): string {
  return PARTIAL_MESSAGE_ID_PREFIX + (parentToolUseId ?? 'main');
}

export interface MessageLike {
  id: string;
  sequence: number;
  type?: string;
  content?: unknown;
}

function supersedesPartial(message: MessageLike, partialId: string): boolean {
  if (message.type === 'result' || isErrorMessage(message)) return true;
  if (message.type !== 'assistant' && message.type !== 'user') return false;
  return partialId === partialMessageId(getParentToolUseId(message.content));
}

function isErrorMessage(message: MessageLike): boolean {
  return (
    message.type === 'system' &&
    (message.content as { subtype?: unknown } | null | undefined)?.subtype === 'error'
  );
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
      pageParams: [null] as P[],
    };
  }

  if (isPartial) {
    // Replace this stream's partial on the newest page, or append if none exists.
    const newPages = old.pages.map((page, pageIndex) => {
      if (pageIndex !== 0) return page;
      if (page.messages.some((m) => m.id === message.id)) {
        return {
          ...page,
          messages: page.messages.map((m) => (m.id === message.id ? message : m)),
        };
      }
      return { ...page, messages: [...page.messages, message] };
    });
    return { ...old, pages: newPages };
  }

  // Complete message: drop the partials it supersedes, then insert it unless an
  // earlier delivery (live or snapshot) already did.
  const newPages = [...old.pages];
  const firstPageMessages = newPages[0].messages.filter((m) => !isPartialMessageId(m.id));
  const livePartials = newPages[0].messages.filter(
    (m) => isPartialMessageId(m.id) && !supersedesPartial(message, m.id)
  );
  if (old.pages.some((page) => page.messages.some((m) => m.id === message.id))) {
    if (firstPageMessages.length + livePartials.length === newPages[0].messages.length) {
      return old;
    }
    newPages[0] = { ...newPages[0], messages: [...firstPageMessages, ...livePartials] };
    return { ...old, pages: newPages };
  }

  // Insert at the sequence position among the newest page's complete messages,
  // keeping the partials this message doesn't supersede after them. Scans from the
  // end: the common case is an append.
  let insertAt = firstPageMessages.length;
  while (insertAt > 0 && firstPageMessages[insertAt - 1].sequence > message.sequence) {
    insertAt--;
  }
  firstPageMessages.splice(insertAt, 0, message);
  newPages[0] = { ...newPages[0], messages: [...firstPageMessages, ...livePartials] };
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

/**
 * The transcript part of a stream snapshot (see `sse.onSessionEvents`):
 * - `page`: a fresh connection's newest page. Replaces the cache — whatever an
 *   earlier mount cached may be separated from it by a gap.
 * - `since`: a resumed connection's every persisted message with
 *   `sequence > after`. Authoritative for that range, so it also heals a
 *   `message_removed` the client missed; older cached pages stay.
 */
export type HistorySnapshot<M> =
  | { kind: 'page'; messages: M[]; hasMore: boolean }
  | { kind: 'since'; after: number; messages: M[] };

/**
 * Apply a stream snapshot's transcript to the infinite-query cache. Partials are
 * always dropped: the stream re-sends each in-progress one whole with its next delta.
 */
export function applyHistorySnapshot<M extends MessageLike, P = unknown>(
  old: MessageInfiniteCache<M, P> | undefined,
  snapshot: HistorySnapshot<M>
): MessageInfiniteCache<M, P> {
  if (snapshot.kind === 'page' || !old || old.pages.length === 0) {
    const hasMore = snapshot.kind === 'page' ? snapshot.hasMore : snapshot.after >= 0;
    return { pages: [{ messages: snapshot.messages, hasMore }], pageParams: [null] as P[] };
  }
  const present = new Set(snapshot.messages.map((m) => m.id));
  let result: MessageInfiniteCache<M, P> = {
    ...old,
    pages: old.pages.map((page) => ({
      ...page,
      messages: page.messages.filter(
        (m) => !isPartialMessageId(m.id) && (m.sequence <= snapshot.after || present.has(m.id))
      ),
    })),
  };
  for (const message of snapshot.messages) result = mergeMessageIntoCache(result, message);
  return result;
}
