import type { UploadedAttachment } from './attachments';

/**
 * A prompt Stop pulled back from the SDK before the agent ever read it.
 *
 * The server deletes the transcript bubble of anything it successfully recalls —
 * the message describes something that never happened — so by the time this
 * reaches the client it is the **only remaining copy** of what the user wrote.
 * Every consumer must put it somewhere the user can see.
 */
export interface CancelledPrompt {
  /** The user's typed text (original, un-sanitized). */
  text: string;
  /** Files that were attached to it, ready to re-attach to the composer. */
  attachments: UploadedAttachment[];
}

/**
 * Merge recalled prompts back into whatever the composer already holds.
 *
 * Recalled text is never dropped, only ordered: it goes first, because the user
 * typed it before whatever they have started writing since. (Contrast the
 * send-failure path, which leaves a newer draft alone — there the failed message
 * is still in the transcript, so nothing is lost by skipping the restore.)
 */
export function mergeCancelledText(current: string, cancelled: readonly CancelledPrompt[]): string {
  const restored = cancelled.map((p) => p.text).filter((t) => t.length > 0);
  if (restored.length === 0) return current;
  if (current.length === 0) return restored.join('\n\n');
  return [...restored, current].join('\n\n');
}

/**
 * Merge recalled attachments into the composer's, dropping any the user has
 * already re-attached (stored names are unique per upload).
 */
export function mergeCancelledAttachments(
  current: readonly UploadedAttachment[],
  cancelled: readonly CancelledPrompt[]
): UploadedAttachment[] {
  const seen = new Set(current.map((a) => a.storedName));
  const restored = cancelled
    .flatMap((p) => p.attachments)
    .filter((a) => !seen.has(a.storedName) && seen.add(a.storedName));
  return restored.length === 0 ? [...current] : [...restored, ...current];
}
