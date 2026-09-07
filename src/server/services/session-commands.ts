import type { SDKMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { SystemInitContentSchema } from '@/lib/claude-messages';
import { sseEvents } from './events';
import type { SessionState } from './session-state';

/**
 * Slash commands per session, kept across query teardown so the composer can
 * fetch them between queries and after page reloads. Cleared only when the
 * session is deleted.
 */
const persistedCommands = new Map<string, SlashCommand[]>();

/**
 * Merge slash command names from the system init message with rich SlashCommand
 * objects from `supportedCommands()`: the latter returns only skills (rich
 * metadata) while the init message lists every command name.
 */
export function mergeSlashCommands(
  existingCommands: SlashCommand[],
  slashCommandNames: string[]
): SlashCommand[] {
  const existingNames = new Set(existingCommands.map((cmd) => cmd.name));
  const merged = [...existingCommands];

  for (const name of slashCommandNames) {
    if (!existingNames.has(name)) {
      merged.push({ name, description: '', argumentHint: '' });
      existingNames.add(name);
    }
  }

  return merged;
}

export function rememberSessionCommands(sessionId: string, commands: SlashCommand[]): void {
  persistedCommands.set(sessionId, commands);
}

export function getSessionCommands(sessionId: string): SlashCommand[] {
  return persistedCommands.get(sessionId) ?? [];
}

export function forgetSessionCommands(sessionId: string): void {
  persistedCommands.delete(sessionId);
}

/** Fold slash commands discovered in a system init message into the session. */
export function mergeInitCommands(
  sessionId: string,
  state: SessionState,
  message: SDKMessage
): void {
  const initParsed = SystemInitContentSchema.safeParse(message);
  if (!initParsed.success || !initParsed.data.slash_commands) return;

  const merged = mergeSlashCommands(state.commands, initParsed.data.slash_commands);
  const oldNames = new Set(state.commands.map((c) => c.name));
  if (!merged.some((c) => !oldNames.has(c.name))) return;
  state.commands = merged;
  rememberSessionCommands(sessionId, merged);
  sseEvents.emitCommands(sessionId, merged);
}
