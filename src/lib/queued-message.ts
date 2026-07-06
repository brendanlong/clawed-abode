/**
 * Max messages the server holds queued for a session before a further send is
 * rejected. A generous ceiling — reaching it is pathological — that bounds the
 * combined turn a flush produces. Shared by the runner (enqueue guard) and the
 * client (so the composer can surface the cap).
 */
export const MAX_QUEUED_MESSAGES = 50;

/**
 * A user message the server is holding while a main-agent turn is active (async
 * "btw mode"). Queued messages live in the session's in-memory state — they are
 * NOT persisted to the transcript until they flush — and are surfaced to the
 * client over the `queued` SSE channel so it can render them (pinned below the
 * transcript) with a ✕ to remove one before it sends.
 *
 * The server is authoritative: the client never decides whether a send queues
 * (that depends on the live turn state the server owns). A send that arrives
 * mid-turn is queued; a send that arrives idle starts a turn. Queued messages
 * flush as a single combined turn when the turn ends **naturally** — an interrupt
 * deliberately leaves them queued (see `interruptClaude`), so stopping Claude
 * never instantly fires the queue as a new turn.
 *
 * In-memory only: lost on stop / restart before flush (they were never
 * persisted, so nothing lingers in the transcript).
 */
export interface QueuedMessage {
  /** Server-generated id, used to cancel a single queued message. */
  id: string;
  /** The user's typed text (original, un-sanitized — for display). */
  text: string;
  /** Stored names of files attached to this message (see /api/upload). */
  attachments: string[];
}
