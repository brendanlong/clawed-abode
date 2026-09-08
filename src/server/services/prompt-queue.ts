/**
 * The durable per-session queue of prompts held back while a session is paused
 * for a subscription rate limit (doc/rate-limit-pause.md).
 *
 * A queued prompt has **already written its transcript bubble** — the user sees
 * exactly what they sent, badged "queued" — so a row here is only the payload
 * needed to push it into the SDK later. That is why entries are re-pushed rather
 * than re-persisted, and why cancelling one deletes both the row and the bubble.
 *
 * Positions come from `Session.queuedPromptSequence` via the same atomic
 * `UPDATE ... RETURNING` trick as message sequences (see message-store): SQLite
 * serializes it on the write lock, so concurrent enqueues never collide on
 * `@@unique([sessionId, position])` with no read-then-insert.
 */

import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import { sseEvents } from './events';

const log = createLogger('prompt-queue');

/** A prompt waiting for the session's rate-limit hold to release. */
export interface QueuedPrompt {
  id: string;
  position: number;
  /** Id of the transcript bubble already written for this prompt. */
  messageId: string;
  /** Prepared (attachment-prefixed, sanitized) text to push into the SDK. */
  content: string;
  /** The user's original typed text, for restore-on-cancel. */
  text: string;
  /** Stored upload names (see /api/upload). */
  attachments: string[];
}

function toQueuedPrompt(row: {
  id: string;
  position: number;
  messageId: string;
  content: string;
  text: string;
  attachments: string;
}): QueuedPrompt {
  let attachments: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.attachments);
    if (Array.isArray(parsed))
      attachments = parsed.filter((a): a is string => typeof a === 'string');
  } catch {
    // A row written by an older/other writer with unparseable attachments still
    // carries a usable prompt; dropping the files beats dropping the work.
    log.warn('Ignoring unparseable queued-prompt attachments', { queuedPromptId: row.id });
  }
  return { ...row, attachments };
}

const QUEUE_SELECT = {
  id: true,
  position: true,
  messageId: true,
  content: true,
  text: true,
  attachments: true,
} as const;

/**
 * Append prompts to a session's queue in order, reserving all their positions in
 * one statement and writing them in one insert — a partial write would strand the
 * remainder with no path back to the SDK (their in-flight entries are already
 * cancelled by the time this runs).
 */
export async function enqueuePrompts(
  sessionId: string,
  prompts: Omit<QueuedPrompt, 'id' | 'position'>[]
): Promise<void> {
  if (prompts.length === 0) return;
  const rows = await prisma.$queryRaw<{ queuedPromptSequence: number | bigint }[]>`
    UPDATE "Session"
    SET "queuedPromptSequence" = "queuedPromptSequence" + ${prompts.length}
    WHERE "id" = ${sessionId}
    RETURNING "queuedPromptSequence"
  `;
  if (rows.length === 0) {
    throw new Error(`enqueuePrompts: session ${sessionId} not found`);
  }
  const nextPosition = Number(rows[0].queuedPromptSequence) - prompts.length;

  await prisma.queuedPrompt.createMany({
    data: prompts.map((prompt, index) => ({
      sessionId,
      position: nextPosition + index,
      messageId: prompt.messageId,
      content: prompt.content,
      text: prompt.text,
      attachments: JSON.stringify(prompt.attachments),
    })),
  });
}

/** A session's queued prompts, oldest first. */
export async function listQueuedPrompts(sessionId: string): Promise<QueuedPrompt[]> {
  const rows = await prisma.queuedPrompt.findMany({
    where: { sessionId },
    orderBy: { position: 'asc' },
    select: QUEUE_SELECT,
  });
  return rows.map(toQueuedPrompt);
}

/**
 * Transcript ids of a session's queued prompts, in queue order — what the client
 * badges "queued". Streams live over the `queued` SSE channel.
 */
export async function queuedMessageIds(sessionId: string): Promise<string[]> {
  const rows = await prisma.queuedPrompt.findMany({
    where: { sessionId },
    orderBy: { position: 'asc' },
    select: { messageId: true },
  });
  return rows.map((r) => r.messageId);
}

/** Emit the session's current queued transcript ids over SSE. */
export async function emitQueuedPrompts(sessionId: string): Promise<void> {
  sseEvents.emitQueuedMessages(sessionId, await queuedMessageIds(sessionId));
}

/**
 * Claim a queued prompt for pushing, returning false if it is already gone.
 *
 * The delete is the claim, and it must happen **before** the push: the drain works
 * from a snapshot, so a Stop landing mid-drain would otherwise clear the rows and
 * delete the bubbles while the loop went on pushing the prompts the user just
 * took back. Losing the race here means skipping the prompt, which is what
 * cancelling asked for.
 */
export async function claimQueuedPrompt(id: string): Promise<boolean> {
  const { count } = await prisma.queuedPrompt.deleteMany({ where: { id } });
  return count > 0;
}

/**
 * How many prompts are waiting across all sessions. Archived sessions are
 * excluded: archiving leaves the session row in place (so the cascade never
 * fires) and nothing drains an archived session, so counting theirs would report
 * work that can never run.
 */
export function countQueuedPrompts(): Promise<number> {
  return prisma.queuedPrompt.count({ where: { session: { status: { not: 'archived' } } } });
}

/**
 * Empty a session's queue and return what was in it, so the caller can delete the
 * bubbles and hand the text back to the composer (the Stop path — see
 * `interruptClaude`) or discard them (archive). The rows go first, so a drain
 * racing this finds nothing left to claim.
 */
export async function clearQueuedPrompts(sessionId: string): Promise<QueuedPrompt[]> {
  const queued = await listQueuedPrompts(sessionId);
  if (queued.length === 0) return [];
  await prisma.queuedPrompt.deleteMany({ where: { id: { in: queued.map((q) => q.id) } } });
  return queued;
}
