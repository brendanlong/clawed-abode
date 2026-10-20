/**
 * Pure helpers for the client's cache of a session's transcript: one
 * chronological list, written by the session stream (snapshots, live messages,
 * removals) and extended backward as older pages load.
 *
 * Every write is a function of the cache as it is when the write lands, never of
 * a copy taken earlier, so live writes and older-page loads commute — which is
 * why this isn't a TanStack infinite query (see `doc/messages-and-sse.md`).
 *
 * Two kinds of messages arrive over the stream:
 * - **Partial** messages (id from {@link partialMessageId}) are transient streaming
 *   snapshots of an in-progress assistant message. The main agent and each subagent
 *   stream concurrently, so there is one partial per stream, keyed by
 *   `parent_tool_use_id`; each new snapshot replaces its stream's previous one. They
 *   sit after the complete messages.
 * - **Complete** messages are persisted. An assistant or user message supersedes
 *   its own stream's partial; a turn `result` or an error supersedes them all (a
 *   stream cut off by an interrupt, crash, or stop never completes). It is
 *   inserted by `sequence`, deduped by id — a re-delivered id is not merged, so
 *   the cache never reconciles an edit, but it still supersedes partials (a
 *   snapshot can deliver a message ahead of the partials that preceded its live
 *   event). A complete message leaves through {@link removeMessageFromCache}, when
 *   the server deletes the row outright, or {@link applyHistorySnapshot}.
 *
 * Inserting by sequence (not arrival order) keeps the list chronological even if
 * the server emits two concurrently persisted messages out of order; the message
 * list relies on that ordering instead of re-sorting.
 */

import { getParentToolUseId } from './claude-messages';

/**
 * Top-level rows per history page (the stream snapshot's newest page and each
 * backward `getHistory` page), plus the context between them. 30 fills a couple
 * of phone screens per round trip; on prod that averaged ~780 KB a page, mostly
 * tool-result bodies, so raise it once those load on demand (#653).
 */
export const HISTORY_PAGE_SIZE = 30;

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

/** A session's cached transcript, oldest-first, partials last. */
export interface TranscriptCache<M extends MessageLike> {
  messages: M[];
  /** Whether the server has messages older than the oldest cached one. */
  hasMore: boolean;
}

/**
 * Merge a single live message into the cache. Pure: returns a new cache object
 * (or the same reference when nothing changes, e.g. a duplicate).
 */
export function mergeMessageIntoCache<M extends MessageLike>(
  old: TranscriptCache<M> | undefined,
  message: M
): TranscriptCache<M> {
  if (!old) return { messages: [message], hasMore: false };

  if (isPartialMessageId(message.id)) {
    // Replace this stream's partial, or append if none exists.
    const messages = old.messages.some((m) => m.id === message.id)
      ? old.messages.map((m) => (m.id === message.id ? message : m))
      : [...old.messages, message];
    return { ...old, messages };
  }

  // Complete message: drop the partials it supersedes, then insert it unless an
  // earlier delivery (live or snapshot) already did.
  const completes = old.messages.filter((m) => !isPartialMessageId(m.id));
  const livePartials = old.messages.filter(
    (m) => isPartialMessageId(m.id) && !supersedesPartial(message, m.id)
  );
  if (completes.some((m) => m.id === message.id)) {
    if (completes.length + livePartials.length === old.messages.length) return old;
    return { ...old, messages: [...completes, ...livePartials] };
  }

  // Insert at the sequence position, keeping the partials this message doesn't
  // supersede after it. Scans from the end: the common case is an append.
  let insertAt = completes.length;
  while (insertAt > 0 && completes[insertAt - 1].sequence > message.sequence) {
    insertAt--;
  }
  completes.splice(insertAt, 0, message);
  return { ...old, messages: [...completes, ...livePartials] };
}

/**
 * Drop a message from the cache by id. Used when the server deletes a row the
 * transcript should no longer claim happened — a prompt cancelled by Stop before
 * the agent ever read it. Pure: returns the same reference when the id is absent.
 */
export function removeMessageFromCache<M extends MessageLike>(
  old: TranscriptCache<M> | undefined,
  messageId: string
): TranscriptCache<M> | undefined {
  if (!old || !old.messages.some((m) => m.id === messageId)) return old;
  return { ...old, messages: old.messages.filter((m) => m.id !== messageId) };
}

/**
 * The transcript part of a stream snapshot (see `sse.onSessionEvents`): every
 * persisted message with `sequence > after` (oldest-first), whether older ones
 * exist, and the in-progress partials. Authoritative for that range: what the
 * server no longer has is gone, and its rows win over cached ones.
 */
export interface HistorySnapshot<M> {
  after: number;
  messages: M[];
  hasMore: boolean;
  partials: M[];
}

/**
 * Apply a stream snapshot's transcript to the cache. When the cache reaches into
 * the snapshot's range, the two join without a gap, so the snapshot replaces the
 * cache's part of its range and older cached messages (the user's scroll-back)
 * stay. Otherwise — an empty cache, or one an earlier mount left behind that
 * many messages have since passed — the snapshot replaces it. Either way the
 * cached partials are replaced by the snapshot's.
 */
export function applyHistorySnapshot<M extends MessageLike>(
  old: TranscriptCache<M> | undefined,
  snapshot: HistorySnapshot<M>
): TranscriptCache<M> {
  const joins = old?.messages.some(
    (m) => !isPartialMessageId(m.id) && m.sequence >= snapshot.after
  );
  let result: TranscriptCache<M> =
    old && joins
      ? {
          hasMore: old.hasMore,
          messages: [
            ...old.messages.filter(
              (m) => !isPartialMessageId(m.id) && m.sequence <= snapshot.after
            ),
            ...snapshot.messages,
          ],
        }
      : { messages: snapshot.messages, hasMore: snapshot.hasMore };
  for (const partial of snapshot.partials) result = mergeMessageIntoCache(result, partial);
  return result;
}

/**
 * The `getHistory` cursor for the page before the cache's oldest message, or
 * undefined when there is nothing older to load.
 */
export function olderPageCursor<M extends MessageLike>(
  cache: TranscriptCache<M> | undefined
): number | undefined {
  if (!cache?.hasMore) return undefined;
  return cache.messages.find((m) => !isPartialMessageId(m.id))?.sequence;
}

/**
 * Prepend an older page fetched with `cursor` onto the cache as it is now. If the
 * cache no longer starts at that cursor (a snapshot replaced it, or another load
 * of the same page landed first), the page doesn't join it and is dropped; the
 * next scroll-back fetches from the new cursor.
 */
export function prependOlderPage<M extends MessageLike>(
  old: TranscriptCache<M> | undefined,
  cursor: number,
  page: TranscriptCache<M>
): TranscriptCache<M> | undefined {
  if (!old || olderPageCursor(old) !== cursor) return old;
  return { messages: [...page.messages, ...old.messages], hasMore: page.hasMore };
}
