import { v4 as uuid, v5 as uuidv5 } from 'uuid';
import { prisma } from '@/lib/prisma';
import { createLogger, toError } from '@/lib/logger';
import { buildSyntheticToolResultContent } from '@/lib/tool-response';
import { buildPromptWithAttachments } from '@/lib/attachments';
import type { SanitizationInfo } from '@/lib/sanitization';
import { sseEvents } from './events';
import { sanitizeUntrustedInput } from './input-sanitizer';
import { resolveUploadPaths } from './uploads';

const log = createLogger('message-store');

/** Namespace for deterministic (idempotent) message ids derived from content. */
const MESSAGE_ID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

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
 * pagination never assumes contiguity. Emits `new_message` on a real insert.
 * Throws if the session does not exist.
 */
export async function insertMessage(params: {
  sessionId: string;
  id: string;
  type: 'system' | 'user' | 'assistant' | 'result';
  content: unknown;
}): Promise<{ inserted: boolean; sequence?: number }> {
  const { sessionId, id, type, content } = params;
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
  try {
    const message = await prisma.message.create({
      data: { id, sessionId, sequence, type, content: contentJson },
    });
    createdAt = message.createdAt;
  } catch (err) {
    // The only unique key left to violate is the primary-key `id` (the sequence is race-free).
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      log.debug('insertMessage: duplicate id, skipping', { sessionId, id });
      return { inserted: false };
    }
    throw err;
  }

  sseEvents.emitNewMessage(sessionId, { id, sessionId, sequence, type, content, createdAt });
  return { inserted: true, sequence };
}

/**
 * Bump the session's activity timestamp (drives session-list ordering). Called
 * only for genuine user interactions — a prompt or an interactive-tool answer —
 * never for assistant/background traffic, so the list doesn't shuffle while the
 * user reads it. Best-effort.
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
}

/** Persist a system error message for display to the user. */
export async function createErrorMessage(sessionId: string, errorText: string): Promise<void> {
  const errorId = uuidv5(`${sessionId}:error:${Date.now()}:${errorText}`, MESSAGE_ID_NAMESPACE);
  const errorContent = {
    type: 'system',
    subtype: 'error',
    content: [{ type: 'text', text: errorText }],
  };
  try {
    await insertMessage({ sessionId, id: errorId, type: 'system', content: errorContent });
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
 * Targets the last assistant/result message (skipping interleaved background and
 * system task messages, which can otherwise be the highest-sequence row).
 */
export async function markLastMessageAsInterrupted(sessionId: string): Promise<void> {
  log.info('markLastMessageAsInterrupted', { sessionId });

  const lastMainMessage = await prisma.message.findFirst({
    where: { sessionId, type: { in: ['assistant', 'result'] } },
    orderBy: { sequence: 'desc' },
    select: { id: true, sequence: true, type: true, content: true },
  });

  if (lastMainMessage) {
    try {
      const content = JSON.parse(lastMainMessage.content);
      content.interrupted = true;
      await prisma.message.update({
        where: { id: lastMainMessage.id },
        data: { content: JSON.stringify(content) },
      });
      sseEvents.emitNewMessage(sessionId, {
        id: lastMainMessage.id,
        sessionId,
        sequence: lastMainMessage.sequence,
        type: lastMainMessage.type,
        content,
        createdAt: new Date(),
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
    id: uuid(),
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
