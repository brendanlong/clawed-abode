/** `find -printf` format whose lines {@link createOwnedBytesCounter} reads: type, inode, link count, 512-byte blocks. */
export const FIND_ENTRY_FORMAT = '%y %i %n %b\\n';

/**
 * Totals the disk space a directory tree owns outright. A hardlinked file
 * counts only once every one of its links has been seen inside the tree, so
 * files shared with a cache outside it (pnpm's store, uv's cache) are left out
 * — deleting the tree wouldn't free them. Directories always count: their link
 * count reflects subdirectories, not sharing.
 */
export function createOwnedBytesCounter() {
  const linksSeen = new Map<string, number>();
  let bytes = 0;

  return {
    add(line: string): void {
      const [type, inode, nlinkText, blocksText] = line.split(' ');
      const nlink = Number(nlinkText);
      const entryBytes = Number(blocksText) * 512;
      if (!inode || !Number.isFinite(nlink) || !Number.isFinite(entryBytes)) return;
      if (type === 'd' || nlink <= 1) {
        bytes += entryBytes;
        return;
      }
      const seen = (linksSeen.get(inode) ?? 0) + 1;
      linksSeen.set(inode, seen);
      if (seen === nlink) bytes += entryBytes;
    },
    get bytes(): number {
      return bytes;
    },
  };
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}
