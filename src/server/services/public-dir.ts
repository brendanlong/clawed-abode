import { readdir, realpath, stat } from 'fs/promises';
import type { Stats } from 'fs';
import path from 'path';
import type { DirectoryEntry } from '@/lib/public-files';
import { getSessionWorkspacePath } from './worktree-manager';

/**
 * A session's browser-served directory: `public/` in the workspace, a sibling of
 * the repo clone like `uploads/`, so it is removed with the workspace on archive.
 */
export function getSessionPublicDir(sessionId: string): string {
  return path.join(getSessionWorkspacePath(sessionId), 'public');
}

export type PublicTarget =
  | { kind: 'file'; path: string }
  | { kind: 'directory'; index: string }
  | { kind: 'directory'; index: null; entries: DirectoryEntry[] }
  | { kind: 'notFound' };

/**
 * Resolve request segments to what should be served. Symlinks are followed, but
 * the resolved path must stay inside the public dir — agents may link within it,
 * never out of it.
 */
export async function resolvePublicTarget(
  sessionId: string,
  segments: string[]
): Promise<PublicTarget> {
  let root: string;
  try {
    root = await realpath(getSessionPublicDir(sessionId));
  } catch {
    return { kind: 'notFound' };
  }
  const target = await resolveInside(root, segments);
  if (!target) return { kind: 'notFound' };

  if (target.stats.isFile()) {
    return { kind: 'file', path: target.path };
  }
  if (!target.stats.isDirectory()) {
    return { kind: 'notFound' };
  }

  const index = await resolveInside(root, [...segments, 'index.html']);
  if (index?.stats.isFile()) {
    return { kind: 'directory', index: index.path };
  }
  const dirents = await readdir(target.path, { withFileTypes: true });
  return {
    kind: 'directory',
    index: null,
    entries: dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory() })),
  };
}

async function resolveInside(
  root: string,
  segments: string[]
): Promise<{ path: string; stats: Stats } | null> {
  try {
    const resolved = await realpath(path.join(root, ...segments));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return null;
    }
    return { path: resolved, stats: await stat(resolved) };
  } catch {
    return null;
  }
}
