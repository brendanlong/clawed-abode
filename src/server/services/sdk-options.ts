import type { McpServerConfig, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '@/lib/logger';
import { CLAUDE_BIN_ENV, SESSION_SCOPE_ENV, sessionScopeUnitName } from '@/lib/session-scope';
import { buildAgentEnv } from './agent-env';
import { sanitizeToolOutputHook } from './input-sanitizer';
import { writeSessionMcpConfig, removeSessionMcpConfig } from './mcp-config-file';
import { getSessionScopeConfig, sessionScopeNonce } from './session-cgroup';
import { persistSessionScope, type SessionState } from './session-state';
import type { MergedSessionSettings } from './settings-merger';

const log = createLogger('sdk-options');

/** Convert merged MCP server settings into the SDK's record shape. */
export function buildMcpServersRecord(
  mcpServers: MergedSessionSettings['mcpServers']
): Record<string, McpServerConfig> | undefined {
  if (!mcpServers.length) return undefined;
  return Object.fromEntries(
    mcpServers.map((server) => {
      if (server.type === 'stdio') {
        const config: McpServerConfig = { command: server.command };
        if (server.args?.length) (config as { args?: string[] }).args = server.args;
        if (server.env && Object.keys(server.env).length > 0)
          (config as { env?: Record<string, string> }).env = server.env;
        return [server.name, config];
      }
      const config: McpServerConfig = { type: server.type, url: server.url };
      if (server.headers && Object.keys(server.headers).length > 0) {
        (config as { headers?: Record<string, string> }).headers = server.headers;
      }
      return [server.name, config];
    })
  );
}

/**
 * Build the SDK query options for a session. Settings bind here (see
 * doc/settings.md "Live vs Restart-Bound"); the `canUseTool` callback parks
 * interactive tool requests on `state.pendingInput`.
 */
export async function buildSdkOptions(params: {
  sessionId: string;
  workingDir: string;
  settings: MergedSessionSettings;
  shouldResume: boolean;
  state: SessionState;
}): Promise<Options> {
  const { sessionId, workingDir, settings, shouldResume, state } = params;
  const agentEnv = await buildAgentEnv(settings.envVars, settings.claudeApiKey);
  const mcpServersRecord = buildMcpServersRecord(settings.mcpServers);

  const options: Options = {
    env: agentEnv,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    cwd: workingDir,
    settingSources: settings.settingSources,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: settings.systemPrompt,
    },
    tools: { type: 'preset', preset: 'claude_code' },
    canUseTool: async (
      toolName: string,
      input: Record<string, unknown>,
      { toolUseID }: { toolUseID: string }
    ): Promise<PermissionResult> => {
      if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') {
        log.info('canUseTool: Waiting for user input', { sessionId, toolName, toolUseID });
        // No running-state toggle here: the answer UI is DB-derived (a tool_use
        // with no tool_result), and the turn genuinely remains active while parked.
        return await new Promise<PermissionResult>((resolve, reject) => {
          if (state.pendingInput) {
            state.pendingInput.reject(new Error('Superseded by another tool request'));
          }
          state.pendingInput = { toolName, toolUseId: toolUseID, input, resolve, reject };
        });
      }
      return { behavior: 'allow', updatedInput: input };
    },
    hooks: {
      // Sanitize tool output before the model sees it (doc/security.md). Findings
      // are recorded by tool_use_id so the matching tool_result message can carry
      // a "content filtered" badge when it is persisted.
      PostToolUse: [
        {
          hooks: [
            (input) =>
              sanitizeToolOutputHook(input, sessionId, (toolUseId, info) => {
                state.toolSanitizations.set(toolUseId, info);
              }),
          ],
        },
      ],
    },
  };

  // cwd MUST be stable across a resume — Claude Code keys sessions by project dir.
  if (shouldResume) {
    options.resume = sessionId;
  } else {
    options.sessionId = sessionId;
  }
  if (settings.claudeModel) {
    options.model = settings.claudeModel;
  }

  // MCP config goes through a mode-0600 file, never `options.mcpServers`, which the
  // SDK would put on the argv where secrets leak (doc/settings.md "Secrets").
  if (mcpServersRecord && Object.keys(mcpServersRecord).length > 0) {
    const mcpConfigPath = await writeSessionMcpConfig(sessionId, mcpServersRecord);
    options.extraArgs = { ...options.extraArgs, 'mcp-config': mcpConfigPath };
  } else {
    // Drop any config written on a previous establish so old secrets don't linger.
    await removeSessionMcpConfig(sessionId);
  }

  // The advisor model has no SDK option; it is an ad-hoc `--settings` source,
  // omitted entirely when disabled. Wires up `advisor_20260301` on SDK 0.3.196+
  // (verified by capturing the CLI's outgoing /v1/messages request; re-verify the
  // same way after SDK bumps).
  if (settings.advisorModel) {
    options.extraArgs = {
      ...options.extraArgs,
      settings: JSON.stringify({ advisorModel: settings.advisorModel }),
    };
  }

  // Run the CLI (and everything it spawns) in a transient systemd user scope so the
  // whole tree is reaped on teardown (doc/claude-sessions.md "Process Reaping").
  // The unit name is recorded on the DB row BEFORE the subprocess exists, so a
  // crash between here and teardown can always reap it by exact name.
  const scopeConfig = await getSessionScopeConfig();
  if (scopeConfig) {
    const unit = sessionScopeUnitName(sessionId, sessionScopeNonce());
    state.sessionScope = unit;
    await persistSessionScope(sessionId, unit);
    options.pathToClaudeCodeExecutable = scopeConfig.launcherPath;
    agentEnv[SESSION_SCOPE_ENV] = unit;
    agentEnv[CLAUDE_BIN_ENV] = scopeConfig.claudeBin;
  }

  return options;
}
