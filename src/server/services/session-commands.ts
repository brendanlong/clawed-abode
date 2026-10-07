import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { CommandsChangedContentSchema, SystemInitContentSchema } from '@/lib/claude-messages';
import { processSingleton } from '@/lib/process-singleton';
import { sseEvents } from './events';

interface CommandCache {
  /** The SDK's full list: from `supportedCommands()`, replaced by each `commands_changed`. */
  all: SlashCommand[];
  /** Names the latest init flagged as terminal-only (`terminal_slash_commands`). */
  terminalOnly: ReadonlySet<string>;
}

/**
 * Slash commands per session, kept across query teardown so the composer can
 * fetch them between queries and after page reloads. Cleared only when the
 * session is deleted.
 */
const cache = processSingleton('session-commands', () => new Map<string, CommandCache>());

const EMPTY: CommandCache = { all: [], terminalOnly: new Set() };

/** Commands to offer in the composer: terminal-only ones make no sense on a phone. */
export function visibleCommands(
  all: SlashCommand[],
  terminalOnly: ReadonlySet<string>
): SlashCommand[] {
  return all.filter((cmd) => !terminalOnly.has(cmd.name));
}

export function getSessionCommands(sessionId: string): SlashCommand[] {
  const { all, terminalOnly } = cache.get(sessionId) ?? EMPTY;
  return visibleCommands(all, terminalOnly);
}

function update(sessionId: string, patch: Partial<CommandCache>): void {
  cache.set(sessionId, { ...(cache.get(sessionId) ?? EMPTY), ...patch });
  sseEvents.emitCommands(sessionId, getSessionCommands(sessionId));
}

export function replaceSessionCommands(sessionId: string, commands: SlashCommand[]): void {
  update(sessionId, { all: commands });
}

export function forgetSessionCommands(sessionId: string): void {
  cache.delete(sessionId);
}

function sameNames(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((name) => b.has(name));
}

/**
 * Apply a streamed message's effect on the command list: `commands_changed`
 * replaces it, and each init restates which commands are terminal-only.
 */
export function applyCommandMessage(sessionId: string, message: unknown): void {
  const changed = CommandsChangedContentSchema.safeParse(message);
  if (changed.success) {
    replaceSessionCommands(sessionId, changed.data.commands);
    return;
  }

  const init = SystemInitContentSchema.safeParse(message);
  if (!init.success) return;
  const terminalOnly = new Set(init.data.terminal_slash_commands ?? []);
  if (sameNames(terminalOnly, (cache.get(sessionId) ?? EMPTY).terminalOnly)) return;
  update(sessionId, { terminalOnly });
}
