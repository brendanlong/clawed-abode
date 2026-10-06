import type {
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  Options,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import { AGENT_NAME_ENV } from '@/lib/agent-name';
import { createLogger } from '@/lib/logger';
import { mayChangeBranchOrPr } from '@/lib/pull-request';
import type { SanitizationInfo } from '@/lib/sanitization';
import { CLAUDE_BIN_ENV, SESSION_SCOPE_ENV, sessionScopeUnitName } from '@/lib/session-scope';
import { buildAgentEnv } from './agent-env';
import { BUILTIN_MCP_SERVER_NAME, builtinToolsPrompt } from '@/lib/builtin-tools';
import { buildBuiltinMcpServer } from './builtin-mcp';
import { sanitizeToolOutputHook } from './input-sanitizer';
import { writeSessionMcpConfig, removeSessionMcpConfig } from './mcp-config-file';
import { scheduleBranchPrRefresh } from './session-branch-pr';
import { getSessionScopeConfig, sessionScopeNonce } from './session-cgroup';
import type { MergedSessionSettings } from './settings-merger';

const log = createLogger('sdk-options');

/** An interactive tool request (AskUserQuestion / ExitPlanMode) awaiting the user. */
export interface UserInputRequest {
  toolName: string;
  /** The tool_use block id, used to match an incoming answer to this request. */
  toolUseId: string;
  input: Record<string, unknown>;
}

export interface SdkOptionsResult {
  options: Options;
  /**
   * The systemd scope unit the CLI will run in, or null when cgroup scoping is
   * unavailable. The runner records it on the DB row before the subprocess exists
   * so a crash can always reap it by exact name.
   */
  sessionScope: string | null;
  /**
   * The in-process built-in server, or null when disabled. A live `setMcpServers`
   * must pass it again or the SDK disconnects it.
   */
  builtinMcpServer: McpSdkServerConfigWithInstance | null;
}

/** The record for a live `setMcpServers`: the configured servers plus the built-in one. */
export function buildLiveMcpServersRecord(
  mcpServers: MergedSessionSettings['mcpServers'],
  builtinMcpServer: McpSdkServerConfigWithInstance | null
): Record<string, McpServerConfig> {
  return {
    ...buildMcpServersRecord(mcpServers),
    ...(builtinMcpServer && { [BUILTIN_MCP_SERVER_NAME]: builtinMcpServer }),
  };
}

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
 * doc/settings.md "Live vs Restart-Bound").
 */
export async function buildSdkOptions(params: {
  sessionId: string;
  /** Name other Claude sessions address this one by (see doc/claude-sessions.md). */
  agentName: string | null;
  /** Whether the session still has its auto-generated name, so the agent is asked to rename it. */
  sessionNameIsDefault: boolean;
  workingDir: string;
  settings: MergedSessionSettings;
  /** Claude Code conversation to resume, or null to start one under `sessionId`. */
  resumeId: string | null;
  /** Answers an interactive tool call; the turn stays parked until it settles. */
  waitForUserInput: (request: UserInputRequest) => Promise<PermissionResult>;
  /** Records sanitizer findings for a tool result, to badge it when persisted. */
  recordSanitization: (toolUseId: string, info: SanitizationInfo) => void;
}): Promise<SdkOptionsResult> {
  const {
    sessionId,
    agentName,
    sessionNameIsDefault,
    workingDir,
    settings,
    resumeId,
    waitForUserInput,
    recordSanitization,
  } = params;
  const agentEnv = await buildAgentEnv(settings.envVars, settings.claudeApiKey);
  if (agentName) agentEnv[AGENT_NAME_ENV] = agentName;
  const mcpServersRecord = buildMcpServersRecord(settings.mcpServers);

  const options: Options = {
    env: agentEnv,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    cwd: workingDir,
    settingSources: settings.settingSources,
    // snapshot: false keeps the appended prompt rendered fresh on every request.
    // The SDK's default flipped to true in 0.3.266, which records the prompt on a
    // conversation's first request and replays it verbatim through every later
    // `resume` — and we resume every session whose CLI started a conversation, so
    // an edited system prompt would never reach an existing session, breaking the
    // Stop→Start contract in doc/settings.md.
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: settings.builtinTools
        ? `${settings.systemPrompt}\n\n${builtinToolsPrompt(settings.builtinTools, sessionNameIsDefault)}`
        : settings.systemPrompt,
      snapshot: false,
    },
    tools: { type: 'preset', preset: 'claude_code' },
    // Echo user messages the CLI injected itself, e.g. from other sessions.
    extraArgs: { 'replay-user-messages': null },
    canUseTool: async (
      toolName: string,
      input: Record<string, unknown>,
      { toolUseID }: { toolUseID: string }
    ): Promise<PermissionResult> => {
      if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') {
        log.info('canUseTool: Waiting for user input', { sessionId, toolName, toolUseID });
        // No running-state toggle here: the answer UI is DB-derived (a tool_use
        // with no tool_result), and the turn genuinely remains active while parked.
        return await waitForUserInput({ toolName, toolUseId: toolUseID, input });
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
            (input) => sanitizeToolOutputHook(input, sessionId, recordSanitization),
            async (input) => {
              if (
                input.hook_event_name === 'PostToolUse' &&
                mayChangeBranchOrPr(input.tool_name, input.tool_input)
              ) {
                scheduleBranchPrRefresh(sessionId, workingDir);
              }
              return {};
            },
          ],
        },
      ],
    },
  };

  // cwd MUST be stable across a resume — Claude Code keys sessions by project dir.
  if (resumeId) {
    options.resume = resumeId;
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

  // The built-in server is the one `options.mcpServers` entry: an in-process SDK
  // instance is registered over the control channel, never serialized onto argv.
  const builtinMcpServer = settings.builtinTools
    ? buildBuiltinMcpServer(sessionId, settings.builtinTools)
    : null;
  if (builtinMcpServer) {
    options.mcpServers = { [BUILTIN_MCP_SERVER_NAME]: builtinMcpServer };
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
  const scopeConfig = await getSessionScopeConfig();
  if (!scopeConfig) return { options, sessionScope: null, builtinMcpServer };

  const sessionScope = sessionScopeUnitName(sessionId, sessionScopeNonce());
  options.pathToClaudeCodeExecutable = scopeConfig.launcherPath;
  agentEnv[SESSION_SCOPE_ENV] = sessionScope;
  agentEnv[CLAUDE_BIN_ENV] = scopeConfig.claudeBin;
  return { options, sessionScope, builtinMcpServer };
}
