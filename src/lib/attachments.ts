/**
 * Pure helpers for user-uploaded file attachments.
 *
 * Attachments are uploaded to a directory outside the repo (see
 * `src/server/services/uploads.ts`) and their absolute paths are prefixed onto
 * the next user message so Claude knows where to find them.
 */

export interface UploadedAttachment {
  /** Original file name, for display in the UI. */
  name: string;
  /** Server-side stored basename (collision-proofed), used to resolve the path. */
  storedName: string;
  /** Absolute path on the host where the file was saved. */
  path: string;
}

/**
 * Build the prompt sent to Claude, prefixing a note about any uploaded files.
 * Matches the format requested in issue #75:
 *   [User uploaded file(s): /tmp/.../a.md, /tmp/.../b.png]
 *
 * The prefix is prepended to the (trimmed) user text, or sent on its own when
 * the user attached files without typing a message.
 */
export function buildPromptWithAttachments(prompt: string, paths: string[]): string {
  const trimmed = prompt.trim();
  if (paths.length === 0) {
    return trimmed;
  }
  const prefix = `[User uploaded file(s): ${paths.join(', ')}]`;
  return trimmed ? `${prefix}\n\n${trimmed}` : prefix;
}

/**
 * Recover a human-friendly file name from a stored name for display. Stored
 * names are `${8-hex-token}-${safeName}` (see `saveUploadedFile`); this strips
 * the collision-proofing token so a composer chip shows the original-ish name
 * rather than the random prefix. Falls back to the input if it doesn't
 * match the expected shape.
 */
export function displayFileName(storedName: string): string {
  return storedName.replace(/^[0-9a-f]{8}-/, '');
}

/** Leaves room for the stored-name prefix within the usual 255-byte filename limit. */
const MAX_SAFE_NAME_LENGTH = 200;

/**
 * Strip directory components and unsafe characters from an uploaded file name,
 * neutralizing path traversal. Returns a safe basename suitable for storage;
 * overlong names keep their tail so the extension survives.
 */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  // Collapse anything that isn't alphanumeric, dot, dash, or underscore, and
  // strip leading dots so we never produce a dotfile or "..".
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(-MAX_SAFE_NAME_LENGTH)
    .replace(/^\.+/, '');
  return cleaned || 'file';
}
