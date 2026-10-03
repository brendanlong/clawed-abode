import { mkdir, access, rm } from 'fs/promises';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import path from 'path';
import { randomBytes } from 'node:crypto';
import { sanitizeFileName, type UploadedAttachment } from '@/lib/attachments';
import { getSessionWorkspacePath } from './worktree-manager';
import { createLogger } from '@/lib/logger';

const log = createLogger('uploads');

/**
 * Directory for a session's uploaded files: an `uploads/` folder inside the
 * session's workspace (a sibling of the repo clone, not inside it — so uploads
 * don't pollute git status). Living in the workspace makes them durable for the
 * life of the session and cleaned up automatically when the session is archived
 * (the whole workspace is removed).
 */
export function getSessionUploadDir(sessionId: string): string {
  return path.join(getSessionWorkspacePath(sessionId), 'uploads');
}

/**
 * Stream an uploaded file body to the session's upload directory. The stored
 * name is prefixed with a short random token so re-uploading the same filename
 * never overwrites an earlier upload (no check-then-set). A partially written
 * file (e.g. the client disconnected) is removed before the error propagates.
 */
export async function saveUploadedFile(
  sessionId: string,
  originalName: string,
  body: ReadableStream<Uint8Array> | null
): Promise<UploadedAttachment> {
  const dir = getSessionUploadDir(sessionId);
  await mkdir(dir, { recursive: true });

  const safeName = sanitizeFileName(originalName);
  const storedName = `${randomBytes(4).toString('hex')}-${safeName}`;
  const filePath = path.join(dir, storedName);

  const output = createWriteStream(filePath, { flags: 'wx' });
  let created = false;
  output.once('open', () => (created = true));
  try {
    await pipeline(
      body ? Readable.fromWeb(body as NodeReadableStream<Uint8Array>) : Readable.from([]),
      output
    );
  } catch (err) {
    // Only remove a file this call created; on EEXIST it belongs to another upload.
    if (created) await rm(filePath, { force: true });
    throw err;
  }
  log.info('Saved uploaded file', { sessionId, storedName, bytes: output.bytesWritten });

  return { name: originalName, storedName, path: filePath };
}

/**
 * Resolve client-provided stored names back to absolute paths for the message
 * prefix. `path.basename` neutralizes any traversal in the client-supplied name,
 * and any file that no longer exists on disk is dropped (logged) rather than
 * failing the whole send.
 */
export async function resolveUploadPaths(
  sessionId: string,
  storedNames: string[]
): Promise<string[]> {
  const dir = getSessionUploadDir(sessionId);
  const resolved = await Promise.all(
    storedNames.map(async (name) => {
      const filePath = path.join(dir, path.basename(name));
      try {
        await access(filePath);
        return filePath;
      } catch {
        log.warn('Attachment not found on disk, skipping', { sessionId, name });
        return null;
      }
    })
  );
  return resolved.filter((p): p is string => p !== null);
}
