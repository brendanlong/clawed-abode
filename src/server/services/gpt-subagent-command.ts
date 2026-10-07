import { gptSubagentScript } from '@/lib/gpt-subagent';
import { createLogger, toError } from '@/lib/logger';
import { getClaudeBinary, writeGeneratedScript } from './session-cgroup';

const log = createLogger('gpt-subagent-command');

export interface GptSubagentCommand {
  path: string;
  /** The CLI the command runs: the session's own version, not whatever is on PATH. */
  claudeBin: string;
}

/**
 * Write the GPT subagent command, or return null if it can't run here (the
 * session then just doesn't get it). Rewritten per establishment, like the
 * session launcher, so it self-heals and tracks the current models.
 */
export async function ensureGptSubagentCommand(dir?: string): Promise<GptSubagentCommand | null> {
  const claudeBin = await getClaudeBinary();
  if (!claudeBin) return null;
  try {
    return {
      path: await writeGeneratedScript('gpt-subagent', gptSubagentScript(), dir),
      claudeBin,
    };
  } catch (err) {
    log.warn('Could not write the GPT subagent command', { error: toError(err).message });
    return null;
  }
}
