/**
 * Each session's `TMPDIR`, so temp files agents leave behind are removed when
 * the session is archived instead of piling up in the host's (RAM-backed) /tmp.
 * It lives under /tmp rather than in the workspace to keep Unix socket paths
 * that tools create in `$TMPDIR` under the ~108-byte limit.
 */

import { lstat, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

function sessionTmpRoot(): string {
  return join(tmpdir(), 'clawed-abode');
}

export function getSessionTmpDir(sessionId: string): string {
  return join(sessionTmpRoot(), sessionId);
}

/**
 * Create the session's temp dir. Runs on every query establishment, since a
 * reboot empties /tmp while the session survives. /tmp is world-writable, so
 * the shared root must be a real directory only we can write to, or another
 * user could pre-create it (or a symlink) and read or plant files in it.
 */
export async function ensureSessionTmpDir(sessionId: string): Promise<string> {
  const rootPath = sessionTmpRoot();
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  const root = await lstat(rootPath);
  if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o077) !== 0) {
    throw new Error(`${rootPath} must be a directory owned by this user with mode 0700`);
  }
  const dir = getSessionTmpDir(sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function removeSessionTmpDir(sessionId: string): Promise<void> {
  await rm(getSessionTmpDir(sessionId), { recursive: true, force: true });
}
