import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gptSubagentScript } from '@/lib/gpt-subagent';
import { createLogger, toError } from '@/lib/logger';
import { LAUNCHER_DIR } from './session-cgroup';

const log = createLogger('gpt-subagent-command');

/**
 * Write the GPT subagent command and return its path, or null if it can't be
 * written (the session then just doesn't get it). Rewritten per establishment,
 * like the session launcher, so it self-heals and tracks the current models.
 */
export async function ensureGptSubagentCommand(dir: string = LAUNCHER_DIR): Promise<string | null> {
  const path = join(dir, 'gpt-subagent');
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path, gptSubagentScript(), { mode: 0o755 });
    await chmod(path, 0o755);
    return path;
  } catch (err) {
    log.warn('Could not write the GPT subagent command', { error: toError(err).message });
    return null;
  }
}
