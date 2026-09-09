import { mkdir, writeFile, chmod } from 'fs/promises';
import path from 'path';

/**
 * Write a file only the owner can read, creating its directory.
 *
 * `chmod` is explicit because `writeFile`'s mode is only applied when the file is
 * created — without it, overwriting an existing file would keep the old mode.
 */
export async function writeSecretFile(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, { mode: 0o600 });
  await chmod(filePath, 0o600);
}
