import type { UploadedAttachment } from './attachments';

/**
 * Max number of messages the client may hold pending (and flush together via
 * `claude.sendBatch`). A generous ceiling — reaching it is pathological — that
 * bounds the batch the server persists in one flush. Shared by the composer and
 * the `sendBatch` input schema so the two can't drift.
 */
export const MAX_QUEUED_MESSAGES = 50;

/**
 * A user message the client is holding while a main-agent turn is active (async
 * "btw mode"). Pending messages live **only** on the client — they are shown
 * pinned at the bottom of the transcript (below the persisted messages), can be
 * removed individually, and are flushed together via `claude.sendBatch` when the
 * turn ends. They are not persisted until they flush, so cancelling one (or
 * reclaiming them all into the composer on interrupt) never touches the database.
 */
export interface PendingMessage {
  /** Client-generated id, used to cancel a single pending message. */
  id: string;
  /** The user's typed text (original, un-sanitized — for display and restore). */
  text: string;
  /** Files attached to this pending message (chips shown on the bubble). */
  attachments: UploadedAttachment[];
}
