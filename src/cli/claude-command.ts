/**
 * Pure helpers for assembling the interactive `claude` command line that the
 * abode CLI launches inside tmux. All per-repo/global configuration comes from
 * the database and is injected via CLI flags and environment variables, so
 * nothing is ever written into the repo clone.
 */

import type { ContainerEnvVar, ContainerMcpServer } from '@/server/services/repo-settings';

/** Config file shape accepted by `claude --mcp-config` (same as .mcp.json). */
export interface McpConfigFile {
  mcpServers: Record<
    string,
    | { command: string; args?: string[]; env?: Record<string, string> }
    | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  >;
}

/**
 * Convert merged MCP server settings into the `--mcp-config` file format.
 * Returns null when there are no servers configured.
 */
export function buildMcpConfig(servers: ContainerMcpServer[]): McpConfigFile | null {
  if (servers.length === 0) return null;

  const mcpServers: McpConfigFile['mcpServers'] = {};
  for (const server of servers) {
    if (server.type === 'stdio') {
      mcpServers[server.name] = {
        command: server.command,
        ...(server.args?.length ? { args: server.args } : {}),
        ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
      };
    } else {
      mcpServers[server.name] = {
        type: server.type,
        url: server.url,
        ...(server.headers && Object.keys(server.headers).length > 0
          ? { headers: server.headers }
          : {}),
      };
    }
  }
  return { mcpServers };
}

export interface ClaudeArgsOptions {
  /** Session UUID — used as --session-id on first launch, --resume afterwards */
  sessionId: string;
  /** Resume an existing Claude Code conversation instead of starting fresh */
  resume: boolean;
  /** Model override (repo → global → env resolution already applied) */
  model?: string;
  /** Full system prompt to append (built by buildSystemPrompt) */
  systemPromptAppend?: string;
  /** Path to the generated MCP config file, if any servers are configured */
  mcpConfigPath?: string;
  /** Initial prompt sent on first launch (ignored when resuming) */
  initialPrompt?: string;
}

/**
 * Build the argv for the interactive `claude` invocation.
 * Mirrors the web app's SDK options: bypassed permissions, appended system
 * prompt, DB-configured MCP servers, and a stable session ID for resume.
 */
export function buildClaudeArgs(options: ClaudeArgsOptions): string[] {
  const args: string[] = [];

  if (options.resume) {
    args.push('--resume', options.sessionId);
  } else {
    args.push('--session-id', options.sessionId);
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.systemPromptAppend) {
    args.push('--append-system-prompt', options.systemPromptAppend);
  }

  if (options.mcpConfigPath) {
    args.push('--mcp-config', options.mcpConfigPath);
  }

  args.push('--dangerously-skip-permissions');

  if (!options.resume && options.initialPrompt) {
    args.push(options.initialPrompt);
  }

  return args;
}

/**
 * Build the environment variable overlay for a session.
 * Mirrors buildAgentEnv's precedence: global API key first, then merged
 * (global + per-repo) env vars so per-repo values win. The tmux session
 * inherits the user's login shell environment as the base.
 */
export function buildSessionEnvVars(
  envVars: ContainerEnvVar[],
  claudeApiKey?: string | null
): Record<string, string> {
  const result: Record<string, string> = {};

  if (claudeApiKey) {
    result['CLAUDE_CODE_OAUTH_TOKEN'] = claudeApiKey;
  }

  for (const { name, value } of envVars) {
    result[name] = value;
  }

  return result;
}

/**
 * Quote argv elements into a single string safe to pass as a tmux
 * shell-command (tmux runs it via `sh -c`).
 */
export function shellQuote(args: string[]): string {
  return args.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(' ');
}
