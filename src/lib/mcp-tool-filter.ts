import { z } from 'zod';

/**
 * Which of an MCP server's tools the agent gets. `allowed` is the allowlist;
 * `hidden` is every other tool the server listed when the filter was saved, so
 * they can be removed from the agent's context by name. A tool in neither (one
 * the server added later) is still blocked — see doc/settings.md.
 */
export const mcpToolFilterSchema = z.object({
  allowed: z.array(z.string().min(1).max(500)).max(1000),
  hidden: z.array(z.string().min(1).max(500)).max(1000),
});
export type McpToolFilter = z.infer<typeof mcpToolFilterSchema>;

/** A tool as the server lists it. `readOnly` is the server's own `readOnlyHint` claim. */
export interface McpToolInfo {
  name: string;
  description?: string;
  readOnly: boolean;
}

export interface FilteredMcpServer {
  name: string;
  toolFilter?: McpToolFilter | null;
}

/** Claude Code's rule for turning a server or tool name into part of a tool id. */
function normalizeForToolId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function toolIdPrefix(serverName: string): string {
  return `mcp__${normalizeForToolId(serverName)}__`;
}

/** The id Claude Code gives an MCP tool, e.g. `mcp__todoist__add-tasks`. */
export function mcpToolId(serverName: string, toolName: string): string {
  return toolIdPrefix(serverName) + normalizeForToolId(toolName);
}

/** Deny rules that remove every filtered server's known, non-allowed tools from context. */
export function mcpToolDenyRules(servers: FilteredMcpServer[]): string[] {
  return servers
    .flatMap((server) =>
      (server.toolFilter?.hidden ?? []).map((tool) => mcpToolId(server.name, tool))
    )
    .sort();
}

/**
 * Whether a tool call must be refused: it belongs to a filtered server and isn't
 * on that server's allowlist. Fails closed for tools the filter has never seen.
 */
export function isMcpToolBlocked(servers: FilteredMcpServer[], toolId: string): boolean {
  return servers.some((server) => {
    if (!server.toolFilter || !toolId.startsWith(toolIdPrefix(server.name))) return false;
    return !server.toolFilter.allowed.some((tool) => mcpToolId(server.name, tool) === toolId);
  });
}

/** The filter that allows exactly `allowed` out of the tools a server listed. */
export function buildMcpToolFilter(
  tools: McpToolInfo[],
  allowed: ReadonlySet<string>
): McpToolFilter {
  const names = tools.map((tool) => tool.name);
  return {
    allowed: names.filter((name) => allowed.has(name)),
    hidden: names.filter((name) => !allowed.has(name)),
  };
}
