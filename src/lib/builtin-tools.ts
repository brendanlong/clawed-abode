/** Pure parts of the built-in MCP server (src/server/services/builtin-mcp.ts). */

export const BUILTIN_MCP_SERVER_NAME = 'clawed-abode';

/**
 * Which built-in tools a session gets; null in merged settings means none.
 * `basic`: rename itself and list sessions; `manage`: also create, read, and stop them.
 */
export type BuiltinToolsLevel = 'basic' | 'manage';

/** Management tools are a superset of the basic ones, so they need the master switch too. */
export function resolveBuiltinTools(flags: {
  builtinToolsEnabled: boolean;
  sessionToolsEnabled: boolean;
}): BuiltinToolsLevel | null {
  if (!flags.builtinToolsEnabled) return null;
  return flags.sessionToolsEnabled ? 'manage' : 'basic';
}

/** A session created by another agent never gets management tools, so agents can't spawn chains. */
export function sessionBuiltinTools(
  level: BuiltinToolsLevel | null,
  createdBySessionId: string | null
): BuiltinToolsLevel | null {
  return level === 'manage' && createdBySessionId ? 'basic' : level;
}

const MESSAGING =
  "To find other sessions' agents, call list_sessions: each session's agentName is its address for the SendMessage tool.";

/** Appended to the system prompt (doc/settings.md "Built-in Tools"). */
export function builtinToolsPrompt(level: BuiltinToolsLevel, nameIsDefault: boolean): string {
  const rename = nameIsDefault
    ? "This session's name in the user's session list is an auto-generated default. Call the rename_session tool with a short (2–6 word) description of the task as soon as you understand it, before doing the work. Rename again if the task changes substantially."
    : "The user chose this session's name; only use rename_session if they ask.";
  if (level === 'basic') return `${rename}\n\n${MESSAGING}`;
  return `${rename}\n\n${MESSAGING}

The create_session, read_session, and stop_session tools act on the user's other sessions. Only use them when the user asks you to; for ordinary parallel or delegated work, use subagents instead. After creating a session, talk to it with SendMessage and check on it with read_session rather than doing its work yourself.`;
}

/** Label a prompt one agent writes for a session it creates, so it isn't mistaken for the user's. */
export function attributeMessage(
  sender: { id: string; name: string; agentName: string | null },
  text: string
): string {
  const replyTo = sender.agentName
    ? ` Reach it with SendMessage to ${JSON.stringify(sender.agentName)}.`
    : '';
  return `[Written by the agent in session ${JSON.stringify(sender.name)} (${sender.id}), not by the user.${replyTo}]\n\n${text}`;
}
