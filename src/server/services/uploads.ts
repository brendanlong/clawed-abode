import { mkdir, writeFile, access } from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { sanitizeFileName, type UploadedAttachment } from '@/lib/attachments';
import { getSessionWorkspacePath } from './worktree-manager';
import { createLogger } from '@/lib/logger';

const log = createLogger('uploads');

/** Per-file size cap. Large enough for images/docs, small enough to bound disk use. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

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
 * Persist an uploaded file to the session's upload directory. The stored name is
 * prefixed with a short random token so re-uploading the same filename never
 * overwrites an earlier upload (no check-then-set).
 */
export async function saveUploadedFile(
  sessionId: string,
  originalName: string,
  data: Buffer
): Promise<UploadedAttachment> {
  const dir = getSessionUploadDir(sessionId);
  await mkdir(dir, { recursive: true });

  const safeName = sanitizeFileName(originalName);
  const storedName = `${uuid().slice(0, 8)}-${safeName}`;
  const filePath = path.join(dir, storedName);

  await writeFile(filePath, data);
  log.info('Saved uploaded file', { sessionId, storedName, bytes: data.length });

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
