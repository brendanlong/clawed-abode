import { mkdir, access, rm, rename, readdir, lstat } from 'fs/promises';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import path from 'path';
import { randomBytes } from 'node:crypto';
import { sanitizeFileName, type UploadedAttachment } from '@/lib/attachments';
import { getSessionWorkspacePath, getUploadStagingDir } from './worktree-manager';
import { createLogger, toError } from '@/lib/logger';

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

/** Stream an uploaded file body to the session's upload directory. */
export function saveUploadedFile(
  sessionId: string,
  originalName: string,
  body: ReadableStream<Uint8Array> | null
): Promise<UploadedAttachment> {
  return saveUpload(getSessionUploadDir(sessionId), originalName, body);
}

/**
 * Stream a file uploaded for a session that hasn't been created yet into the
 * staging directory; `claimStagedUploads` moves it into the session once it exists.
 */
export async function stageUploadedFile(
  originalName: string,
  body: ReadableStream<Uint8Array> | null
): Promise<UploadedAttachment> {
  await purgeAbandonedStagedUploads();
  return saveUpload(getUploadStagingDir(), originalName, body);
}

/**
 * The stored name is prefixed with a short random token so re-uploading the same
 * filename never overwrites an earlier upload (no check-then-set). A partially
 * written file (e.g. the client disconnected) is removed before the error propagates.
 */
async function saveUpload(
  dir: string,
  originalName: string,
  body: ReadableStream<Uint8Array> | null
): Promise<UploadedAttachment> {
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
  log.info('Saved uploaded file', { dir, storedName, bytes: output.bytesWritten });

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

/**
 * Move staged uploads into a session's upload directory, returning the stored
 * names that moved. The rename is the claim, so a name can only be claimed once;
 * one that is already gone is dropped (logged) like a missing attachment on send.
 */
export async function claimStagedUploads(
  sessionId: string,
  storedNames: string[]
): Promise<string[]> {
  if (storedNames.length === 0) return [];
  const dir = getSessionUploadDir(sessionId);
  await mkdir(dir, { recursive: true });
  const claimed = await Promise.all(
    storedNames.map(async (name) => {
      const base = path.basename(name);
      try {
        await rename(path.join(getUploadStagingDir(), base), path.join(dir, base));
        return base;
      } catch (err) {
        log.warn('Staged upload could not be claimed, skipping', {
          sessionId,
          name,
          error: toError(err).message,
        });
        return null;
      }
    })
  );
  return claimed.filter((name): name is string => name !== null);
}

/** Old enough that no new-session form still holds it. */
const STAGED_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Delete staged uploads that were never claimed (the new-session form was
 * abandoned). Age-based rather than wiping the directory, because a second
 * server on the same host (a dev instance) shares it and may be claiming or
 * purging the same files concurrently.
 */
export async function purgeAbandonedStagedUploads(now = Date.now()): Promise<void> {
  const dir = getUploadStagingDir();
  const names = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  await Promise.all(
    names.map(async (name) => {
      const filePath = path.join(dir, name);
      try {
        const { mtimeMs } = await lstat(filePath);
        if (now - mtimeMs > STAGED_UPLOAD_MAX_AGE_MS)
          await rm(filePath, { recursive: true, force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        log.warn('Could not purge staged upload', { name, error: toError(err).message });
      }
    })
  );
}
