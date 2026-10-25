import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, statfs } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import { createOwnedBytesCounter, FIND_ENTRY_FORMAT } from '@/lib/disk-usage';
import { getSessionWorkspacePath, WORKTREES_DIR } from './worktree-manager';

const log = createLogger('disk-usage');

/**
 * Bytes that deleting `dir` would free (see createOwnedBytesCounter). Walks with
 * `find` rather than Node's fs: over this host's worktrees it is >10x faster
 * than an lstat per entry. Stays on `dir`'s filesystem (deleting a mount point
 * frees nothing on the mounted one). A missing `dir` measures 0; entries that
 * vanish or can't be read mid-walk are skipped.
 */
export async function measureOwnedBytes(dir: string): Promise<number> {
  const child = spawn('find', [dir, '-xdev', '-printf', FIND_ENTRY_FORMAT], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await once(child, 'spawn');
  const exited = once(child, 'close');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    if (stderr.length < 2000) stderr += chunk;
  });

  const counter = createOwnedBytesCounter();
  for await (const line of createInterface({ input: child.stdout })) {
    counter.add(line);
  }
  const [code] = await exited;
  if (code !== 0) {
    log.warn('find reported errors; their entries are not counted', {
      dir,
      code,
      stderr,
    });
  }
  return counter.bytes;
}

export async function getWorkspaceDiskUsage() {
  const sessions = await prisma.session.findMany({
    where: { status: { notIn: ['archived', 'error'] } },
    select: { id: true, name: true, status: true },
  });
  const measured = [];
  for (const session of sessions) {
    measured.push({
      ...session,
      bytes: await measureOwnedBytes(getSessionWorkspacePath(session.id)),
    });
  }
  measured.sort((a, b) => b.bytes - a.bytes);

  await mkdir(WORKTREES_DIR, { recursive: true });
  const fs = await statfs(WORKTREES_DIR);
  return {
    sessions: measured,
    filesystem: { freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize },
    measuredAt: new Date(),
  };
}
