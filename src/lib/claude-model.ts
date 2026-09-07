/**
 * Model used when nothing else names one: the `CLAUDE_MODEL` env default on the
 * server, and the client's placeholder while global settings are still loading.
 */
export const DEFAULT_CLAUDE_MODEL = 'opus[1m]';

/**
 * The model a new override would fall back to if cleared: the global override,
 * else the server's env default, else {@link DEFAULT_CLAUDE_MODEL} while the
 * settings query is still loading.
 */
export function fallbackClaudeModel(
  globalSettings: { claudeModel: string | null; defaultClaudeModel: string } | undefined
): string {
  return globalSettings?.claudeModel ?? globalSettings?.defaultClaudeModel ?? DEFAULT_CLAUDE_MODEL;
}
