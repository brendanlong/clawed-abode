import { mkdir, writeFile, chmod, rm } from 'fs/promises';
import path from 'path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { getSessionWorkspacePath } from './worktree-manager';
import { createLogger } from '@/lib/logger';

const log = createLogger('mcp-config-file');

/**
 * Filename of the per-session MCP config, written inside the session workspace
 * (a sibling of the repo clone, like `uploads/`, not inside the checkout — so it
 * doesn't pollute git status). Cleaned up automatically when the session is
 * archived (the whole workspace is removed by `removeWorkspace`).
 */
export const MCP_CONFIG_FILENAME = 'mcp-config.json';

/** Absolute path of a session's MCP config file. */
export function getSessionMcpConfigPath(sessionId: string): string {
  return path.join(getSessionWorkspacePath(sessionId), MCP_CONFIG_FILENAME);
}

/**
 * Write the merged MCP server config to a **mode-0600** file in the session
 * workspace and return its path.
 *
 * The config can contain secrets — a GitHub PAT in a stdio `env`, HTTP/SSE
 * `Authorization` headers — so it must NOT be passed inline on the CLI argv
 * (`--mcp-config '<json>'`), where it would leak into journald (the scope unit's
 * ExecStart) and world-readable `/proc/<pid>/cmdline`. Passing a file path keeps
 * the secrets to same-uid/root readers — the same trust boundary as the app
 * itself. See issue #428.
 *
 * The JSON shape (`{ mcpServers: ... }`) matches what the CLI's `--mcp-config`
 * expects for a file. Rewritten on every query establishment so it self-heals if
 * deleted and always reflects the current settings (which are bound at establish
 * anyway). `chmod` is explicit so the mode is guaranteed even when overwriting an
 * existing file (the `writeFile` mode is only applied at creation).
 */
export async function writeSessionMcpConfig(
  sessionId: string,
  mcpServers: Record<string, McpServerConfig>
): Promise<string> {
  const dir = getSessionWorkspacePath(sessionId);
  await mkdir(dir, { recursive: true });

  const filePath = getSessionMcpConfigPath(sessionId);
  await writeFile(filePath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
  await chmod(filePath, 0o600);

  log.info('Wrote session MCP config', { sessionId, servers: Object.keys(mcpServers).length });
  return filePath;
}

/**
 * Remove a session's MCP config file if it exists. Called on establish when the
 * session has no MCP servers, so a config written earlier (when it did have
 * servers, possibly with secrets) doesn't linger on disk until archive.
 * Idempotent — a no-op when the file is already absent.
 */
export async function removeSessionMcpConfig(sessionId: string): Promise<void> {
  await rm(getSessionMcpConfigPath(sessionId), { force: true });
}
