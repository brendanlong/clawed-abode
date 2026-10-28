import { randomUUID } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { prisma } from '@/lib/prisma';
import { createLogger, toError } from '@/lib/logger';
import { buildSyntheticToolResultContent } from '@/lib/tool-response';
import { buildPromptWithAttachments } from '@/lib/attachments';
import type { SanitizationInfo } from '@/lib/sanitization';
import { sseEvents } from './events';
import { clearAttention } from './session-attention';
import { sanitizeUntrustedInput } from './input-sanitizer';
import { redactSecretsDeep } from './secret-redaction';
import { resolveUploadPaths } from './uploads';
import { messageUsageStatement, parseSessionUsageRow } from './session-usage';
import { buildTokenUsageStats } from '@/lib/token-estimation';
import { messageDisplay } from '@/lib/transcript-display';
import { findToolResultText, projectMessageContent } from '@/lib/tool-result';
import type { Message } from '@/generated/prisma/client';

const log = createLogger('message-store');

/** Namespace for deterministic (idempotent) message ids derived from content. */
const MESSAGE_ID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * A message row with its JSON `content` decoded. `display` stays server-side:
 * clients classify with the same `messageDisplay`.
 */
export type ParsedMessage = Omit<Message, 'content' | 'display'> & { content: unknown };

/** Decode a row as stored, for server-side readers (e.g. `read_session`). */
function toParsedMessage({ display: _display, ...row }: Message): ParsedMessage {
  return { ...row, content: JSON.parse(row.content) as unknown };
}

/**
 * A message as the API and SSE deliver it to clients: projected by
 * `projectMessageContent` (large tool-result bodies summarized, unread SDK
 * fields dropped), which doesn't change its `messageDisplay`.
 */
function toClientMessage(message: ParsedMessage): ParsedMessage {
  return { ...message, content: projectMessageContent(message.content) };
}

function toClientMessageFromRow(row: Message): ParsedMessage {
  return toClientMessage(toParsedMessage(row));
}

/** Announce a persisted message, projected exactly as reads deliver it. */
function emitPersistedMessage(sessionId: string, message: ParsedMessage): void {
  sseEvents.emitNewMessage(sessionId, toClientMessage(message));
}

/** Every message a client may need: the rows plus the context they render with. */
const NOT_HIDDEN = { not: 'hidden' } as const;

/** Top-level rows older than `cursor` (or all of them), the unit history pages count. */
function rowsBefore(sessionId: string, cursor: number | null | undefined) {
  return { sessionId, display: 'row', ...(cursor != null && { sequence: { lt: cursor } }) };
}

/**
 * One page of history, paging backward: `limit` top-level rows older than
 * `cursor` (or the newest overall) and every non-hidden message from the oldest
 * of them up to the cursor, oldest-first. Pages are contiguous, so a row's tool
 * results, task events and subagent messages (all newer than it) are loaded by
 * the time it is. The last page reaches back to the start of the session.
 * Projected for clients.
 */
export async function loadHistoryPage(
  sessionId: string,
  cursor: number | null | undefined,
  limit: number
): Promise<{ messages: ParsedMessage[]; hasMore: boolean }> {
  const newestRows = await prisma.message.findMany({
    where: rowsBefore(sessionId, cursor),
    orderBy: { sequence: 'desc' },
    take: limit + 1,
    select: { sequence: true },
  });
  const hasMore = newestRows.length > limit;
  const floor = hasMore ? newestRows[limit - 1].sequence : undefined;
  const rows = await prisma.message.findMany({
    where: {
      sessionId,
      display: NOT_HIDDEN,
      sequence: {
        ...(floor !== undefined && { gte: floor }),
        ...(cursor != null && { lt: cursor }),
      },
    },
    orderBy: { sequence: 'asc' },
  });
  return { messages: rows.map(toClientMessageFromRow), hasMore };
}

/**
 * The newest `limit` top-level rows older than `cursor`, oldest-first, without
 * their context: what an agent reading another session's transcript needs.
 */
export async function loadTranscriptRows(
  sessionId: string,
  cursor: number | null | undefined,
  limit: number
): Promise<{ messages: ParsedMessage[]; hasMore: boolean }> {
  const rows = await prisma.message.findMany({
    where: rowsBefore(sessionId, cursor),
    orderBy: { sequence: 'desc' },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit).reverse().map(toParsedMessage), hasMore };
}

/**
 * Sequence of the earliest message that spawned one of these background tasks
 * (by SDK `task_id`), or null when none is found. Each task's `task_started`
 * names its `tool_use_id`; the spawn is the nearest assistant message before it
 * carrying that id. One statement however many tasks there are.
 */
export async function loadEarliestTaskSpawnSequence(
  sessionId: string,
  taskIds: string[]
): Promise<number | null> {
  if (taskIds.length === 0) return null;
  const rows = await prisma.$queryRaw<{ spawn: number | bigint | null }[]>`
    SELECT MIN((
      SELECT "spawn"."sequence" FROM "Message" AS "spawn"
      WHERE "spawn"."sessionId" = "started"."sessionId"
        AND "spawn"."type" = 'assistant'
        AND "spawn"."sequence" < "started"."sequence"
        AND instr("spawn"."content", '"' || json_extract("started"."content", '$.tool_use_id') || '"') > 0
      ORDER BY "spawn"."sequence" DESC
      LIMIT 1
    )) AS "spawn"
    FROM "Message" AS "started"
    WHERE "started"."sessionId" = ${sessionId}
      AND "started"."display" = 'context'
      AND "started"."type" = 'system'
      AND json_extract("started"."content", '$.subtype') = 'task_started'
      AND json_extract("started"."content", '$.task_id') IN (SELECT "value" FROM json_each(${JSON.stringify(taskIds)}))
  `;
  const spawn = rows[0]?.spawn;
  return spawn === null || spawn === undefined ? null : Number(spawn);
}

/**
 * The full display text of one tool result, whose body clients get only as a
 * summary when it is large; null when the session has no such message or result.
 */
export async function loadToolResultText(
  sessionId: string,
  messageId: string,
  toolUseId: string
): Promise<string | null> {
  const row = await prisma.message.findFirst({
    where: { id: messageId, sessionId },
    select: { content: true },
  });
  return row ? findToolResultText(JSON.parse(row.content), toolUseId) : null;
}

/** Every non-hidden message after `floor`, oldest-first (a resumed stream's snapshot), projected for clients. */
export async function loadMessagesAfter(
  sessionId: string,
  floor: number
): Promise<ParsedMessage[]> {
  const rows = await prisma.message.findMany({
    where: { sessionId, display: NOT_HIDDEN, sequence: { gt: floor } },
    orderBy: { sequence: 'asc' },
  });
  return rows.map(toClientMessageFromRow);
}

/** Whether any non-hidden message has `sequence <= ceiling`. */
export async function hasMessagesThrough(sessionId: string, ceiling: number): Promise<boolean> {
  const row = await prisma.message.findFirst({
    where: { sessionId, display: NOT_HIDDEN, sequence: { lte: ceiling } },
    select: { id: true },
  });
  return row !== null;
}

type StoredMessageType = 'system' | 'user' | 'assistant' | 'result';

function buildErrorContent(errorText: string) {
  return { type: 'system', subtype: 'error', content: [{ type: 'text', text: errorText }] };
}

/**
 * Redact secrets from a message about to be stored. This covers user prompts and
 * assistant text, which the tool-output hook never sees. If redaction fails, the
 * message is replaced by a visible error rather than stored unredacted or
 * dropped, so the user sees that something is missing and the session carries on.
 */
async function redactForStorage(params: {
  sessionId: string;
  id: string;
  type: StoredMessageType;
  content: unknown;
}): Promise<{ type: StoredMessageType; content: unknown }> {
  const { sessionId, id, type } = params;
  try {
    const { value, rules } = await redactSecretsDeep(params.content);
    if (rules.length > 0) log.warn('Redacted secrets from message', { sessionId, id, rules });
    return { type, content: value };
  } catch (err) {
    const error = toError(err);
    log.error('Redacting a message failed; storing an error in its place', error, {
      sessionId,
      id,
    });
    return {
      type: 'system',
      content: buildErrorContent(
        `A ${type} message couldn't be checked for secrets, so it wasn't saved: ${error.message}`
      ),
    };
  }
}

/**
 * Insert a message, assigning its per-session `sequence` atomically: one autocommit
 * `UPDATE ... RETURNING` on `Session.messageSequence`, which SQLite serializes on
 * the write lock, so concurrent inserts never collide on `@@unique([sessionId,
 * sequence])` with no read-then-insert and no interactive transaction (those
 * contend and deadlock under SQLite's single writer). Every persist site must go
 * through here — see src/server/services/CLAUDE.md.
 *
 * A duplicate `id` (e.g. an idempotent synthetic tool_result) is a no-op returning
 * `inserted: false`; the reserved sequence is skipped, a harmless gap since
 * pagination never assumes contiguity. A real insert folds the message into the
 * session's usage totals in the same batch and emits a `message` event, then a
 * `token_usage` event if the totals moved (built from the fold's own `RETURNING`,
 * so announcing them costs no extra query).
 * Secrets in any string are redacted first (see {@link redactForStorage}).
 * Throws if the session does not exist.
 */
export async function insertMessage(params: {
  sessionId: string;
  id: string;
  type: StoredMessageType;
  content: unknown;
}): Promise<{ inserted: boolean; sequence?: number }> {
  const { sessionId, id } = params;
  const { type, content } = await redactForStorage(params);
  const contentJson = JSON.stringify(content);

  const rows = await prisma.$queryRaw<{ messageSequence: number | bigint }[]>`
    UPDATE "Session"
    SET "messageSequence" = "messageSequence" + 1
    WHERE "id" = ${sessionId}
    RETURNING "messageSequence"
  `;
  if (rows.length === 0) {
    throw new Error(`insertMessage: session ${sessionId} not found`);
  }
  const sequence = Number(rows[0].messageSequence) - 1;

  let createdAt: Date;
  let usageRow: unknown;
  try {
    const create = prisma.message.create({
      data: {
        id,
        sessionId,
        sequence,
        type,
        content: contentJson,
        display: messageDisplay(type, content),
      },
    });
    const usage = messageUsageStatement(sessionId, type, content);
    // A batch (not interactive) transaction: a duplicate id rolls back the usage fold too.
    if (usage) {
      const [message, usageRows] = await prisma.$transaction([create, usage]);
      createdAt = message.createdAt;
      usageRow = usageRows[0];
    } else {
      createdAt = (await create).createdAt;
    }
  } catch (err) {
    // The only unique key left to violate is the primary-key `id` (the sequence is race-free).
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      log.debug('insertMessage: duplicate id, skipping', { sessionId, id });
      return { inserted: false };
    }
    throw err;
  }

  emitPersistedMessage(sessionId, { id, sessionId, sequence, type, content, createdAt });
  if (usageRow !== undefined) {
    // The message is already persisted and announced; a bad row must not fail its insert.
    try {
      sseEvents.emitTokenUsage(sessionId, buildTokenUsageStats(parseSessionUsageRow(usageRow)));
    } catch (err) {
      log.error('insertMessage: failed to announce token usage', toError(err), { sessionId, id });
    }
  }
  return { inserted: true, sequence };
}

/**
 * Bump the session's activity timestamp (drives session-list ordering) and clear
 * its "needs you" flag, since the user is plainly looking at it. Called only for
 * genuine user interactions — a prompt or an interactive-tool answer — never for
 * assistant/background traffic, so the list doesn't shuffle while the user reads
 * it. Best-effort.
 */
export async function bumpSessionActivity(sessionId: string): Promise<void> {
  try {
    await prisma.session.update({
      where: { id: sessionId },
      data: { lastActivityAt: new Date() },
    });
  } catch (err) {
    log.warn('Failed to bump session lastActivityAt', {
      sessionId,
      error: toError(err).message,
    });
  }
  await clearAttention(sessionId);
}

/** Persist a system error message for display to the user. */
export async function createErrorMessage(sessionId: string, errorText: string): Promise<void> {
  const errorId = randomUUID();
  try {
    await insertMessage({
      sessionId,
      id: errorId,
      type: 'system',
      content: buildErrorContent(errorText),
    });
  } catch (err) {
    log.error('Failed to create error message', toError(err), { sessionId });
  }
}

/**
 * Delete persisted messages and tell connected clients to drop them. One statement
 * for the whole batch; the per-id events are what the clients actually key on.
 */
export async function removeMessages(sessionId: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  const { count } = await prisma.message.deleteMany({
    where: { sessionId, id: { in: messageIds } },
  });
  if (count === 0) return;
  for (const messageId of messageIds) sseEvents.emitMessageRemoved(sessionId, messageId);
}

/**
 * Persist a synthetic `tool_result` for a tool_use whose query has ended, so the
 * UI pairs the dangling block and stops showing answer controls. Idempotent via a
 * deterministic id derived from the tool_use id.
 *
 * @returns true if a result was written, false if this tool call was already answered.
 */
export async function persistSyntheticToolResult(
  sessionId: string,
  toolUseId: string,
  text: string
): Promise<boolean> {
  const id = uuidv5(`${sessionId}:tool_result:${toolUseId}`, MESSAGE_ID_NAMESPACE);
  const content = buildSyntheticToolResultContent({ sessionId, toolUseId, uuid: id, text });
  const { inserted } = await insertMessage({ sessionId, id, type: 'user', content });
  if (!inserted) {
    log.debug('persistSyntheticToolResult: tool call already answered', { sessionId, toolUseId });
  }
  return inserted;
}

/**
 * Mark the last main-agent message as interrupted and append an interrupt marker.
 * Targets the last assistant/result message the transcript shows as a row,
 * skipping subagent messages, empty fragments, and interleaved system task
 * messages, any of which can otherwise be the highest-sequence message.
 */
export async function markLastMessageAsInterrupted(sessionId: string): Promise<void> {
  log.info('markLastMessageAsInterrupted', { sessionId });

  const lastMainMessage = await prisma.message.findFirst({
    where: { sessionId, display: 'row', type: { in: ['assistant', 'result'] } },
    orderBy: { sequence: 'desc' },
    select: { id: true, sequence: true, type: true, content: true, createdAt: true },
  });

  if (lastMainMessage) {
    try {
      const content = JSON.parse(lastMainMessage.content);
      content.interrupted = true;
      await prisma.message.update({
        where: { id: lastMainMessage.id },
        data: { content: JSON.stringify(content) },
      });
      emitPersistedMessage(sessionId, {
        id: lastMainMessage.id,
        sessionId,
        sequence: lastMainMessage.sequence,
        type: lastMainMessage.type,
        content,
        createdAt: lastMainMessage.createdAt,
      });
    } catch (err) {
      log.warn('Failed to mark message as interrupted', {
        sessionId,
        error: toError(err).message,
      });
    }
  }

  await insertMessage({
    sessionId,
    id: randomUUID(),
    type: 'user',
    content: { type: 'user', subtype: 'interrupt', content: 'Interrupted' },
  });
}

/** A user message that has been resolved + sanitized but not yet persisted. */
export interface PreparedMessage {
  content: string;
  sanitization?: SanitizationInfo;
}

/**
 * Resolve attachments, build the attachment prefix, and sanitize — with **no DB
 * writes or other side effects**, so a send that fails here leaves nothing behind
 * and the composer can restore the user's text.
 */
export async function prepareUserMessage(
  sessionId: string,
  text: string,
  attachments: string[]
): Promise<PreparedMessage> {
  const paths = attachments.length ? await resolveUploadPaths(sessionId, attachments) : [];
  const withAttachments = buildPromptWithAttachments(text, paths);
  const { cleaned, info } = await sanitizeUntrustedInput(withAttachments, {
    sessionId,
    source: 'user-message',
  });
  return { content: cleaned, ...(info ? { sanitization: info } : {}) };
}

/** Persist a prepared message as its own transcript bubble under a caller-chosen id. */
export function insertPreparedMessage(
  sessionId: string,
  messageId: string,
  prepared: PreparedMessage
) {
  return insertMessage({
    sessionId,
    id: messageId,
    type: 'user',
    content: {
      type: 'user',
      content: prepared.content,
      ...(prepared.sanitization ? { sanitization: prepared.sanitization } : {}),
    },
  });
}
