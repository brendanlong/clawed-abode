/**
 * Orchestrates Claude SDK queries directly in-process.
 *
 * Each session has ONE long-lived `query()` running in streaming-input mode. It is
 * established lazily (`ensureSessionQuery`), stays alive across turns and idle
 * periods — so background tasks (`run_in_background` subagents, Monitor watches,
 * backgrounded Bash) survive and their `task_notification` flows back to the main
 * agent — and is torn down only on stop / delete / shutdown / fatal error.
 *
 * "Busy" splits into two independent axes (see {@link reduceSessionMessage}):
 *   - `turnActive`: the main agent is mid-turn (gates the composer).
 *   - background tasks: an indicator only; never gates input.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  query as sdkQuery,
  type Query,
  type Options,
  type McpServerConfig,
  type SlashCommand,
  type PermissionResult,
  type SDKUserMessage,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { prisma } from '@/lib/prisma';
import {
  classifyMessage,
  parseCommandLifecycle,
  SystemInitContentSchema,
  type RetryState,
} from '@/lib/claude-messages';
import {
  reduceSessionMessage,
  removeBackgroundTask,
  backgroundActive,
  INITIAL_LIVE_STATUS,
  type LiveStatus,
  type BackgroundTask,
} from '@/lib/session-status';
import { createPushable, type Pushable } from '@/lib/pushable';
import { type ToolResponse, buildSyntheticToolResultContent } from '@/lib/tool-response';
import { buildPromptWithAttachments } from '@/lib/attachments';
import { extractRepoFullName } from '@/lib/utils';
import { v4 as uuid, v5 as uuidv5 } from 'uuid';
import { sseEvents } from './events';
import { createLogger, toError } from '@/lib/logger';
import { fetchPullRequestForBranch } from './github';
import { getCurrentBranch, getSessionWorkingDir } from './worktree-manager';
import {
  loadMergedSessionSettings,
  mcpServersEqual,
  type MergedSessionSettings,
} from './settings-merger';
import { StreamAccumulator } from './stream-accumulator';
import { sanitizeUntrustedInput, sanitizeToolOutputHook } from './input-sanitizer';
import {
  getSessionScopeConfig,
  sessionScopeNonce,
  stopSessionScope,
  reapSessionScopes,
} from './session-cgroup';
import { CLAUDE_BIN_ENV, SESSION_SCOPE_ENV, sessionScopeUnitName } from '@/lib/session-scope';
import { type SanitizationInfo } from '@/lib/sanitization';
import { attachToolResultSanitizations } from '@/lib/message-sanitization';
import { PARTIAL_MESSAGE_ID_PREFIX } from '@/lib/message-cache';
import type { ContainerEnvVar } from './repo-settings';
import { resolveUploadPaths } from './uploads';
import { writeSessionMcpConfig, removeSessionMcpConfig } from './mcp-config-file';

const execFileAsync = promisify(execFile);

const log = createLogger('claude-runner');

/**
 * Merges slash command names from the system init message with rich SlashCommand
 * objects from `supportedCommands()`. See the original note: `supportedCommands()`
 * returns only skills (rich metadata); the init message lists all command names.
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

// Namespace UUID for generating deterministic IDs from content.
const ERROR_LINE_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * `turnActive` is derived ENTIRELY from the message stream by `reduceSessionMessage`
 * ([`session-status.ts`](../../lib/session-status.ts)) — a top-level
 * `message_start` sets it true, a top-level `message_delta` with a terminal
 * `stop_reason` sets it false (a top-level `result` is a backstop, and the loop's
 * `finally` forces it false when the query ends). There are deliberately NO status
 * timers (no turn watchdog, no idle reaper): the server cannot distinguish a
 * genuinely hung turn from a slow one by observation, so any timer would be a
 * guess. The deterministic recoveries are user-driven — interrupt (stop the turn)
 * and the header Stop (`sessions.stop`, which closes the query → `finally` clears
 * the flag). A persistent subprocess therefore lives until stop / delete /
 * shutdown / fatal error.
 */

/**
 * State for a pending user input request (AskUserQuestion / ExitPlanMode).
 * The canUseTool callback parks a promise here; the answerQuestion mutation resolves it.
 */
interface PendingUserInput {
  toolName: string;
  /** The tool_use block id, used to match an incoming answer to this request. */
  toolUseId: string;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
}

/** Translate a user's response into the SDK PermissionResult for the live path. */
function buildPermissionResult(
  response: ToolResponse,
  input: Record<string, unknown>
): PermissionResult {
  if (response.kind === 'questions') {
    return {
      behavior: 'allow',
      updatedInput: { questions: input.questions, answers: response.answers },
    };
  }

  if (response.approve) {
    return { behavior: 'allow', updatedInput: input };
  }
  return {
    behavior: 'deny',
    message:
      response.feedback?.trim() || 'User rejected the plan. Please revise it before proceeding.',
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * In-memory state for each active session.
 */
interface SessionState {
  /** The live streaming query, or null when not established (e.g. after restart). */
  query: Query | null;
  /** Input channel feeding the query; push user messages, close to end the query. */
  input: Pushable<SDKUserMessage> | null;
  /** In-flight establishment promise, for coalescing concurrent ensureSessionQuery. */
  establishing: Promise<SessionState> | null;
  /** Two-axis live status + ephemeral retry (derived from the message stream). */
  status: LiveStatus;
  /** Pending user input request, if any. */
  pendingInput: PendingUserInput | null;
  /** Working directory for this session. */
  workingDir: string;
  /** Discovered slash commands (cached for getCommands endpoint). */
  commands: SlashCommand[];
  /** Settings the live query was built with (model/MCP can be applied live later). */
  boundSettings: MergedSessionSettings | null;
  /** Settings key (repoFullName or '__no_repo__') for reloading merged settings. */
  settingsKey: string;
  /**
   * Sanitizer findings from the PostToolUse hook, keyed by tool_use_id, awaiting
   * the matching tool_result message so they can be attached on persist (the
   * message comes from the SDK stream, not from us). Consumed once.
   */
  toolSanitizations: Map<string, SanitizationInfo>;
  /**
   * Messages already pushed into the SDK that the CLI has accepted into its
   * command queue but not yet handed to the model, keyed by the `uuid` we stamped
   * on the pushed message. Tracked from the push until `command_lifecycle` reports
   * the command left the queue (see {@link handleCommandLifecycle}).
   *
   * Two jobs: the ids feed the `pending` SSE channel so the transcript can mark a
   * bubble "not delivered yet", and the text lets {@link interruptClaude} hand a
   * cancelled prompt back to the composer instead of losing it.
   */
  pendingCommands: Map<string, PendingCommand>;
  /**
   * Last value emitted on the `claude_running` channel. The composer's "working"
   * state is `turnActive || pendingCommands.size > 0` ({@link effectiveRunning}),
   * derived from two independently-changing inputs, so the last emitted value is
   * kept here rather than inferred from a status diff.
   */
  emittedRunning: boolean;
  /**
   * Whether this session's CLI has ever emitted a `command_lifecycle` message.
   * That type is undocumented and absent from the SDK's `SDKMessage` union, so a
   * CLI that never emits it would leave {@link pendingCommands} full forever and
   * pin the composer "working". A supporting CLI reports `queued` within
   * milliseconds of the push — long before any turn boundary — which makes "no
   * lifecycle seen by the first boundary" a reliable feature check, and arms the
   * boundary backstop in {@link applyStatus} only for the CLIs that need it.
   */
  commandLifecycleSeen: boolean;
  /**
   * Set by {@link interruptClaude} so the turn-end it triggers is not reported as
   * Claude *finishing* — the user stopped it, and a "Claude is done" notification
   * for cancelled work is a lie. Consumed (cleared) by the turn-end in
   * {@link applyStatus}.
   */
  interruptRequested: boolean;
  /**
   * Name of the transient systemd user scope this session's query is running in
   * (set at establishment when cgroup reaping is available, else null). Stopped on
   * teardown to cgroup-kill the whole session process tree. See session-cgroup.
   */
  sessionScope: string | null;
}

/** A user message handed to the SDK but not yet read by the agent. */
interface PendingCommand {
  /** Id of the persisted transcript bubble for this message. */
  messageId: string;
  /** The user's typed text (original, un-sanitized), for restore-on-cancel. */
  text: string;
}

/** Active sessions tracked in memory. */
const sessions = new Map<string, SessionState>();

/**
 * Persisted commands per session — survives query teardown so the frontend can
 * fetch them between queries and after page reloads.
 */
const persistedCommands = new Map<string, SlashCommand[]>();

/**
 * Injectable query factory (the SDK `query` by default). Tests replace this to
 * drive `runSessionLoop` with a scripted message stream and no real SDK/auth.
 */
type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;
let queryFactory: QueryFactory = sdkQuery;

/** Override the query factory (for tests). Pass null to restore the SDK default. */
export function _setQueryFactory(factory: QueryFactory | null): void {
  queryFactory = factory ?? sdkQuery;
}

/**
 * Insert a message, assigning its per-session `sequence` ATOMICALLY. The sequence
 * is drawn from the `Session.messageSequence` counter via a single
 * `UPDATE ... SET messageSequence = messageSequence + 1 ... RETURNING` statement.
 * Because it is one autocommit statement, SQLite serializes it on the write lock,
 * so concurrent inserts for the same session each get a distinct value and can
 * never collide on `@@unique([sessionId, sequence])` — no read-then-insert, no
 * retry. (An interactive transaction is deliberately avoided: on SQLite's
 * single-writer model, many concurrent interactive transactions contend on the
 * write lock and deadlock/time out; a single statement cannot.)
 *
 * A duplicate `id` (same message inserted twice — e.g. an idempotent synthetic
 * tool_result) makes the `message.create` fail with P2002; the call is a no-op
 * returning `inserted: false`. The counter was already advanced, so that
 * `sequence` is skipped — a harmless gap, since pagination orders by `sequence`
 * and never assumes contiguity. Emits the `new_message` SSE event on a real
 * insert.
 *
 * @internal Exported only for the integration test; the sole intended callers are
 * the persist sites in this module. Throws if the session does not exist.
 */
export async function insertMessage(params: {
  sessionId: string;
  id: string;
  type: 'system' | 'user' | 'assistant' | 'result';
  content: unknown;
}): Promise<{ inserted: boolean; sequence?: number }> {
  const { sessionId, id, type, content } = params;
  const contentJson = JSON.stringify(content);

  // Atomically reserve this insert's exclusive sequence. RETURNING gives back the
  // post-increment counter; the reserved sequence is one less.
  const rows = await prisma.$queryRaw<{ messageSequence: number | bigint }[]>`
    UPDATE "Session"
    SET "messageSequence" = "messageSequence" + 1
    WHERE "id" = ${sessionId}
    RETURNING "messageSequence"
  `;
  if (rows.length === 0) {
    throw new Error(`insertMessage: session ${sessionId} not found`);
  }
  const sequence = Number(rows[0].messageSequence) - 1;

  let createdAt: Date;
  try {
    const message = await prisma.message.create({
      data: { id, sessionId, sequence, type, content: contentJson },
    });
    createdAt = message.createdAt;
  } catch (err) {
    // The only unique key left to violate is the primary-key `id` (the sequence
    // is race-free): a duplicate message. Idempotent no-op; the reserved sequence
    // is skipped (a harmless gap).
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      log.debug('insertMessage: duplicate id, skipping', { sessionId, id });
      return { inserted: false };
    }
    throw err;
  }

  sseEvents.emitNewMessage(sessionId, { id, sessionId, sequence, type, content, createdAt });
  return { inserted: true, sequence };
}

/**
 * Bump the session's activity timestamp (drives session-list ordering). Called
 * only for genuine user interactions — sending a prompt or answering an
 * interactive tool call — not for assistant/background traffic, so sessions
 * working in the background don't shuffle the list while the user is reading
 * it. Best-effort: an ordering hiccup must never fail the interaction.
 */
async function bumpSessionActivity(sessionId: string): Promise<void> {
  try {
    await prisma.session.update({
      where: { id: sessionId },
      data: { lastActivityAt: new Date() },
    });
  } catch (err) {
    log.warn('Failed to bump session lastActivityAt', {
      sessionId,
      error: toError(err).message,
    });
  }
}

/**
 * Create and persist a system error message for display to the user.
 */
async function createErrorMessage(sessionId: string, errorText: string): Promise<void> {
  const errorId = uuidv5(`${sessionId}:error:${Date.now()}:${errorText}`, ERROR_LINE_NAMESPACE);
  const errorContent = {
    type: 'system',
    subtype: 'error',
    content: [{ type: 'text', text: errorText }],
  };
  try {
    await insertMessage({ sessionId, id: errorId, type: 'system', content: errorContent });
  } catch (err) {
    log.error('Failed to create error message', toError(err), { sessionId });
  }
}

/**
 * Get or create the in-memory state for a session.
 */
function getSessionState(sessionId: string, workingDir: string): SessionState {
  let state = sessions.get(sessionId);
  if (!state) {
    state = {
      query: null,
      input: null,
      establishing: null,
      status: INITIAL_LIVE_STATUS,
      pendingInput: null,
      workingDir,
      commands: persistedCommands.get(sessionId) ?? [],
      boundSettings: null,
      settingsKey: '',
      toolSanitizations: new Map(),
      pendingCommands: new Map(),
      emittedRunning: false,
      commandLifecycleSeen: false,
      interruptRequested: false,
      sessionScope: null,
    };
    sessions.set(sessionId, state);
  } else if (workingDir) {
    state.workingDir = workingDir;
  }
  return state;
}

/**
 * Env vars to seed the login shell with (and to use as fallback).
 */
const SEED_ENV_VARS = [
  'HOME',
  'USER',
  'SHELL',
  'LOGNAME',
  'PATH',
  'LANG',
  'TERM',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
];

let cachedBaseEnv: Record<string, string> | null = null;
let pendingBaseEnv: Promise<Record<string, string>> | null = null;

/**
 * Get the base environment by spawning a fresh login shell (PATH, HOME, etc.)
 * without the server's runtime env vars. Cached for the process lifetime.
 */
export async function getBaseEnv(): Promise<Record<string, string>> {
  if (cachedBaseEnv) return cachedBaseEnv;
  if (pendingBaseEnv) return pendingBaseEnv;

  pendingBaseEnv = fetchBaseEnv();
  try {
    return await pendingBaseEnv;
  } finally {
    pendingBaseEnv = null;
  }
}

async function fetchBaseEnv(): Promise<Record<string, string>> {
  try {
    const seedEnv: Record<string, string> = {};
    for (const key of SEED_ENV_VARS) {
      if (process.env[key]) seedEnv[key] = process.env[key]!;
    }
    const { stdout } = await execFileAsync('bash', ['-lc', 'env -0'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: seedEnv as NodeJS.ProcessEnv,
    });

    const baseEnv: Record<string, string> = {};
    for (const entry of stdout.split('\0')) {
      if (!entry) continue;
      const eqIdx = entry.indexOf('=');
      if (eqIdx === -1) continue;
      baseEnv[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
    }

    cachedBaseEnv = baseEnv;
    log.info('Captured base environment from login shell', {
      varCount: Object.keys(baseEnv).length,
    });
    return baseEnv;
  } catch (err) {
    log.error(
      'Failed to capture base environment from login shell, falling back to minimal env',
      toError(err)
    );
    const fallback: Record<string, string> = {};
    for (const key of SEED_ENV_VARS) {
      if (process.env[key]) fallback[key] = process.env[key]!;
    }
    return fallback;
  }
}

/** Reset the cached base env (for testing). */
export function resetBaseEnvCache(): void {
  cachedBaseEnv = null;
  pendingBaseEnv = null;
}

/** Set persisted commands for a session (for testing). */
export function _setPersistedCommands(sessionId: string, commands: SlashCommand[]): void {
  persistedCommands.set(sessionId, commands);
}

/** Clear persisted commands for a session (for testing). */
export function _clearPersistedCommands(sessionId: string): void {
  persistedCommands.delete(sessionId);
}

/**
 * Merge the agent environment from its three sources, lowest to highest
 * precedence: the base (login shell) env, the global Claude API key, and the
 * user-configured env vars. Never removes vars from the base env — a
 * CLAUDE_CODE_OAUTH_TOKEN exported by the login shell passes through when no
 * claudeApiKey is configured.
 */
export function mergeAgentEnv(
  baseEnv: Record<string, string>,
  userEnvVars: ContainerEnvVar[],
  claudeApiKey?: string | null
): Record<string, string | undefined> {
  const agentEnv: Record<string, string | undefined> = { ...baseEnv };

  if (claudeApiKey) {
    agentEnv['CLAUDE_CODE_OAUTH_TOKEN'] = claudeApiKey;
  }

  for (const { name, value } of userEnvVars) {
    agentEnv[name] = value;
  }

  return agentEnv;
}

/**
 * Build the environment variables to pass to the Claude SDK: a fresh login
 * shell's environment merged with the configured overrides (see mergeAgentEnv).
 */
async function buildAgentEnv(
  userEnvVars: ContainerEnvVar[],
  claudeApiKey?: string | null
): Promise<Record<string, string | undefined>> {
  return mergeAgentEnv(await getBaseEnv(), userEnvVars, claudeApiKey);
}

/** Convert merged MCP server settings into the SDK's record shape. */
function buildMcpServersRecord(
  mcpServers: MergedSessionSettings['mcpServers']
): Record<string, McpServerConfig> | undefined {
  if (!mcpServers.length) return undefined;
  return Object.fromEntries(
    mcpServers.map((server) => {
      if (server.type === 'http' || server.type === 'sse') {
        const config: McpServerConfig = { type: server.type, url: server.url };
        if (server.headers && Object.keys(server.headers).length > 0) {
          (config as { headers?: Record<string, string> }).headers = server.headers;
        }
        return [server.name, config];
      }
      const config: McpServerConfig = { command: server.command };
      if (server.args?.length) (config as { args?: string[] }).args = server.args;
      if (server.env && Object.keys(server.env).length > 0)
        (config as { env?: Record<string, string> }).env = server.env;
      return [server.name, config];
    })
  );
}

/**
 * Build the SDK query options for a session, including the `canUseTool` callback
 * that parks interactive tool requests (AskUserQuestion / ExitPlanMode).
 */
async function buildSdkOptions(params: {
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
    // Which Claude Code scopes the SDK loads filesystem config (CLAUDE.md,
    // skills, hooks, permissions) from. Global-only, defaulting to project.
    // Bound at construction like env/systemPrompt — a change takes effect on the
    // next Stop→Start (the SDK exposes no live setter). See resolveSettingSources.
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
      // Sanitize tool output before the model sees it — the primary
      // hidden-content injection surface (web/MCP responses, fetched issue/PR
      // bodies, file/command output). See sanitizeToolOutputHook for the
      // shape-preserving rewrite, change-gating, and fail-open behavior. Findings
      // are recorded by tool_use_id so the matching tool_result message can carry
      // a visible "content filtered" badge in the UI (attached on persist below).
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
  // Pass MCP servers via a mode-0600 file (`--mcp-config <path>`) rather than
  // setting `options.mcpServers`, which the SDK would serialize inline on the CLI
  // argv as `--mcp-config '<json>'` — leaking any PAT / Authorization header /
  // stdio env secret into journald and world-readable /proc/<pid>/cmdline (issue
  // #428). The file lives in the session workspace and is rewritten on each
  // establish (self-heals a deletion, picks up settings changes). Live
  // mid-session MCP changes still go through query.setMcpServers (a stdin control
  // message, not a respawn), so they never touch argv.
  if (mcpServersRecord && Object.keys(mcpServersRecord).length > 0) {
    const mcpConfigPath = await writeSessionMcpConfig(sessionId, mcpServersRecord);
    options.extraArgs = {
      ...options.extraArgs,
      'mcp-config': mcpConfigPath,
    };
  } else {
    // No MCP servers: drop any config written on a previous establish so old
    // secrets don't linger on disk until the workspace is archived.
    await removeSessionMcpConfig(sessionId);
  }

  // The advisor model is a settings-schema field (no dedicated SDK option), so
  // inject it as an ad-hoc `--settings` source. This enables the server-side
  // advisor tool for the session using the resolved model. It is opt-in: when no
  // advisor model is set (null) the setting is omitted entirely, so the tool is
  // not wired into requests and the advisor is disabled. Like env vars and the
  // system prompt, it is bound at query construction — a change takes effect on
  // the next Stop→Start, not live mid-session.
  //
  // NOTE: this only wires up the `advisor_20260301` tool on CLI/SDK versions that
  // implement it. Verified with @anthropic-ai/claude-agent-sdk 0.3.196 by capturing
  // the CLI's outgoing /v1/messages request: the setting alone injects the tool;
  // the `advisor-tool-2026-03-01` beta header is already sent by the CLI
  // unconditionally. On 0.3.173 the setting is inert (the tool is absent from the
  // bundle entirely). 0.3.198 wires the tool but ships a dangling
  // `SDKConversationResetMessage` type that poisons `SDKMessage` to `any` and
  // breaks the classifyMessage exhaustiveness guard — hence the exact pin to
  // 0.3.196 in package.json.
  if (settings.advisorModel) {
    options.extraArgs = {
      ...options.extraArgs,
      settings: JSON.stringify({ advisorModel: settings.advisorModel }),
    };
  }

  // Run the session's Claude CLI (and every process it spawns) inside a transient
  // systemd user scope — its own cgroup — so the whole tree, including daemons the
  // agent backgrounds, is reaped when we stop the scope on teardown (issue #424).
  // We point `pathToClaudeCodeExecutable` at a launcher that execs the real CLI
  // under `systemd-run --user --scope`; a fresh nonce'd unit name per establish
  // avoids colliding with a not-yet-torn-down scope on stop→start / resume, and is
  // stored on state so teardown stops exactly this scope. When systemd/the CLI
  // aren't available the config is null and the session launches normally.
  const scopeConfig = await getSessionScopeConfig();
  if (scopeConfig) {
    const unit = sessionScopeUnitName(sessionId, sessionScopeNonce());
    state.sessionScope = unit;
    // Record the scope name durably BEFORE the query subprocess (and thus the
    // scope) is spawned, so a crash between here and teardown can always reap it
    // by exact name. Over-recording (a name written for a scope that ends up not
    // created, e.g. establish aborts) is harmless — the reap's stop is a no-op.
    await persistSessionScope(sessionId, unit);
    options.pathToClaudeCodeExecutable = scopeConfig.launcherPath;
    agentEnv[SESSION_SCOPE_ENV] = unit;
    agentEnv[CLAUDE_BIN_ENV] = scopeConfig.claudeBin;
  }

  return options;
}

/**
 * Mirror a session's current systemd scope unit name onto its DB row (or clear it
 * with null on teardown), so a crash — which never runs teardown — leaves the
 * orphaned scope name behind for `reapOrphanedSessionScopes` to stop at startup.
 * Best-effort: a failed write only risks a leaked scope after a crash, never
 * correctness. `updateMany` so a missing row (deleted session) is a silent no-op
 * rather than a throw.
 */
async function persistSessionScope(sessionId: string, unit: string | null): Promise<void> {
  try {
    await prisma.session.updateMany({ where: { id: sessionId }, data: { sessionScope: unit } });
  } catch (err) {
    log.warn('Failed to persist session scope for crash reaping', {
      sessionId,
      error: toError(err).message,
    });
  }
}

/**
 * Force all live status off and emit only the channels that changed. Used by the
 * loop `finally`, `stopSession`, and shutdown so a torn-down session never leaves
 * a stale "running"/"background"/"retrying" indicator.
 */
function clearLiveStatus(sessionId: string, state: SessionState): void {
  state.interruptRequested = false;
  // Deliveries in flight die with the query. Their bubbles stay in the transcript
  // (they may well have been read before the teardown — we can't know), but the
  // "not delivered yet" marker must clear or it would hang there forever.
  if (state.pendingCommands.size > 0) {
    state.pendingCommands.clear();
    sseEvents.emitPendingMessages(sessionId, []);
  }
  if (state.status.turnActive) {
    state.status = { ...state.status, turnActive: false };
  }
  syncRunning(sessionId, state);
  if (state.status.backgroundTasks.size > 0) {
    state.status = { ...state.status, backgroundTasks: new Map() };
    sseEvents.emitBackgroundTasks(sessionId, []);
  }
  if (state.status.retry) {
    state.status = { ...state.status, retry: null };
    sseEvents.emitClaudeRetry(sessionId, null);
  }
}

/**
 * Drop a single background task from a session's live set and emit the
 * `background` channel if it was present. Returns whether an entry was removed.
 * Used by the optimistic-stop path so the indicator clears immediately rather
 * than waiting for the SDK's terminal `task_notification` (which it can drop).
 */
function dropBackgroundTask(sessionId: string, state: SessionState, taskId: string): boolean {
  if (!state.status.backgroundTasks.has(taskId)) return false;
  const next = removeBackgroundTask(state.status.backgroundTasks, taskId);
  state.status = { ...state.status, backgroundTasks: next };
  sseEvents.emitBackgroundTasks(sessionId, [...next.values()]);
  return true;
}

/**
 * What the composer shows as "Claude is working": a live main-agent turn, **or** a
 * message we have handed to the SDK that the agent hasn't read yet.
 *
 * The second clause covers the gap between turns. A message pushed mid-turn is
 * usually folded into the running turn, but if the turn ends first the CLI starts
 * a fresh turn for it — and the `result`/`message_start` pair in between would
 * otherwise blip the composer idle and fire a "Claude finished" notification for
 * work that is about to continue.
 */
function effectiveRunning(state: SessionState): boolean {
  return state.status.turnActive || state.pendingCommands.size > 0;
}

/**
 * Emit `claude_running` if the effective value changed since the last emit. Called
 * after anything that can move either input (a status fold, a push, a delivery),
 * so the two can't produce a spurious or missing edge between them.
 */
function syncRunning(sessionId: string, state: SessionState): boolean {
  const running = effectiveRunning(state);
  if (running === state.emittedRunning) return false;
  state.emittedRunning = running;
  sseEvents.emitClaudeRunning(sessionId, running);
  return true;
}

/**
 * Fold a `command_lifecycle` message into the pending set. Anything other than
 * `queued` means the command has left the CLI's queue — `started` (the agent is
 * reading it now) is the normal case, with `completed`/`cancelled` as backstops in
 * case `started` is ever missed. Returns true if the message was a lifecycle event
 * (and so must not be persisted).
 */
function handleCommandLifecycle(sessionId: string, state: SessionState, message: unknown): boolean {
  const lifecycle = parseCommandLifecycle(message);
  if (!lifecycle) return false;
  state.commandLifecycleSeen = true;
  if (lifecycle.state === 'queued') return true;
  if (!state.pendingCommands.delete(lifecycle.command_uuid)) return true;
  sseEvents.emitPendingMessages(sessionId, pendingMessageIds(state));
  syncRunning(sessionId, state);
  return true;
}

/**
 * A point at which the CLI has necessarily dequeued whatever it was going to run:
 * a new top-level assistant message beginning, or a turn's terminal `result`.
 * Used only by the delivery backstop in {@link applyStatus}.
 */
function isDeliveryBoundary(message: SDKMessage): boolean {
  if (message.type === 'result') return true;
  if (message.type !== 'stream_event') return false;
  const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  if (parent !== null && parent !== undefined) return false;
  const event = (message as { event?: { type?: string } }).event;
  return event?.type === 'message_start';
}

/** Transcript ids of the messages still awaiting delivery, in push order. */
function pendingMessageIds(state: SessionState): string[] {
  return [...state.pendingCommands.values()].map((c) => c.messageId);
}

/** A user message that has been resolved + sanitized but not yet persisted. */
interface PreparedMessage {
  content: string;
  sanitization?: SanitizationInfo;
}

/**
 * Resolve attachments, build the attachment prefix, and sanitize — with **no DB
 * writes or other side effects**, so a send that fails here leaves nothing behind
 * and the composer can restore the user's text. All the failure-prone work (fs,
 * sanitizer) happens before anything is committed.
 */
async function prepareUserMessage(
  sessionId: string,
  text: string,
  attachments: string[]
): Promise<PreparedMessage> {
  const paths = attachments.length ? await resolveUploadPaths(sessionId, attachments) : [];
  const withAttachments = buildPromptWithAttachments(text, paths);
  // Strip hidden-content injection vectors before the prompt is persisted or seen
  // by the model. `info` records any findings so the persisted message can show a
  // "content filtered" badge.
  const { cleaned, info } = await sanitizeUntrustedInput(withAttachments, {
    sessionId,
    source: 'user-message',
  });
  return { content: cleaned, ...(info ? { sanitization: info } : {}) };
}

/** Persist a prepared message as its own transcript bubble under a caller-chosen id. */
function insertPreparedMessage(sessionId: string, messageId: string, prepared: PreparedMessage) {
  return insertMessage({
    sessionId,
    id: messageId,
    type: 'user',
    content: {
      type: 'user',
      content: prepared.content,
      ...(prepared.sanitization ? { sanitization: prepared.sanitization } : {}),
    },
  });
}

/**
 * Fold one message into the session's live status and emit changed channels.
 * Runs for EVERY message (including ones that are skipped for persistence, since
 * `api_retry`/`task_*` drive status). Fires per-turn branch/PR detection when a
 * main turn ends.
 */
function applyStatus(sessionId: string, state: SessionState, message: SDKMessage): void {
  const reduced = reduceSessionMessage(state.status, message);
  const status = reduced.status;
  const changed = reduced.changed;
  const turnEnded = changed.turnActive && !status.turnActive;

  // An interrupt's turn-end is not Claude finishing — the user stopped it.
  // `interruptRequested` is a one-shot flag set by interruptClaude; consume it here.
  const interrupted = turnEnded && state.interruptRequested;
  if (turnEnded) state.interruptRequested = false;

  state.status = status;

  // Delivery backstop for a CLI that doesn't report `command_lifecycle` at all
  // (see SessionState.commandLifecycleSeen): at a turn boundary, anything we
  // pushed has been dequeued, so retire it rather than pin the composer forever.
  if (
    !state.commandLifecycleSeen &&
    state.pendingCommands.size > 0 &&
    isDeliveryBoundary(message)
  ) {
    state.pendingCommands.clear();
    sseEvents.emitPendingMessages(sessionId, []);
  }

  syncRunning(sessionId, state);

  // "Claude finished" fires when a main-agent turn ends NATURALLY *and* the session
  // is now fully idle — no background tasks (subagents / Monitor / backgrounded
  // Bash) still running, and nothing we pushed still waiting to be read. It
  // excludes interrupts (`interrupted`) and stop/delete/error teardown (which goes
  // through clearLiveStatus and never routes here). Distinct from a bare
  // running:false edge, which also fires on interrupt/stop.
  //
  // We deliberately fire only on a turn-end (not when a background task drains):
  // when a background task settles the main agent autonomously continues in a new
  // turn (see doc/claude-sessions.md), and *that* turn's end is where we reach
  // fully idle. Firing on the drain would notify prematurely and then again at the
  // continuation's end. The residual case — a background task settling with no
  // continuation — leaves no "finished" signal, an accepted tradeoff (favoring no
  // spurious notification over no missed one).
  if (turnEnded && !interrupted && !backgroundActive(status) && state.pendingCommands.size === 0) {
    sseEvents.emitClaudeFinished(sessionId);
  }
  if (changed.background) {
    sseEvents.emitBackgroundTasks(sessionId, [...status.backgroundTasks.values()]);
  }
  if (changed.retry) sseEvents.emitClaudeRetry(sessionId, status.retry);

  // PR/branch can change within a turn; refresh at the genuine turn end only.
  if (turnEnded) {
    void detectBranchAndPr(sessionId, state.workingDir);
  }
}

/**
 * Detect a branch change and refresh PR status for the session (fire-and-forget).
 */
async function detectBranchAndPr(sessionId: string, workingDir: string): Promise<void> {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { repoUrl: true, currentBranch: true },
    });
    if (!session) return;

    const detectedBranch = await getCurrentBranch(workingDir);
    if (detectedBranch && detectedBranch !== session.currentBranch) {
      const updated = await prisma.session.update({
        where: { id: sessionId },
        data: { currentBranch: detectedBranch },
      });
      sseEvents.emitSessionUpdate(sessionId, updated);
    }

    const branchForPr = detectedBranch ?? session.currentBranch;
    if (session.repoUrl && branchForPr) {
      const repoFullName = extractRepoFullName(session.repoUrl);
      const pr = await fetchPullRequestForBranch(repoFullName, branchForPr);
      if (pr !== undefined) {
        sseEvents.emitPrUpdate(sessionId, pr);
      }
    }
  } catch (err) {
    log.debug('Failed to detect branch or check PR', { sessionId, error: toError(err).message });
  }
}

/** Merge slash commands discovered in a system init message. */
function mergeInitCommands(sessionId: string, state: SessionState, message: SDKMessage): void {
  const initParsed = SystemInitContentSchema.safeParse(message);
  if (!initParsed.success || !initParsed.data.slash_commands) return;

  const merged = mergeSlashCommands(state.commands, initParsed.data.slash_commands);
  const oldNames = new Set(state.commands.map((c) => c.name));
  const hasNew = merged.some((c) => !oldNames.has(c.name));
  if (hasNew) {
    state.commands = merged;
    persistedCommands.set(sessionId, merged);
    sseEvents.emitCommands(sessionId, merged);
  }
}

/**
 * The long-lived output loop for a session's query. Persists complete messages,
 * emits partials, and folds every message into live status. Exits only when the
 * input channel closes, the query is closed, or the SDK throws.
 */
async function runSessionLoop(sessionId: string, state: SessionState, q: Query): Promise<void> {
  const accumulator = new StreamAccumulator();
  let nextPartialSequence = 0;

  try {
    for await (const message of q) {
      // Delivery bookkeeping first: `command_lifecycle` can retire a pending
      // message, which feeds the running state applyStatus is about to emit.
      if (handleCommandLifecycle(sessionId, state, message)) continue;

      // Status derives from EVERY message (including skipped api_retry/task_*).
      applyStatus(sessionId, state, message);

      if (message.type === 'stream_event') {
        const partial = accumulator.accumulate(
          message as {
            type: 'stream_event';
            event: { type: string; [key: string]: unknown };
            parent_tool_use_id: string | null;
            uuid: string;
            session_id: string;
          }
        );
        if (partial) {
          sseEvents.emitNewMessage(sessionId, {
            id: PARTIAL_MESSAGE_ID_PREFIX + partial.uuid,
            sessionId,
            sequence: nextPartialSequence,
            type: 'assistant',
            content: partial,
            createdAt: new Date(),
          });
        }
        continue;
      }

      if (message.type === 'assistant') {
        accumulator.reset();
      }

      mergeInitCommands(sessionId, state, message);

      const handling = classifyMessage(message);
      if (handling.kind !== 'persist') continue;

      // Attach any sanitizer findings for this message's tool results (recorded
      // by the PostToolUse hook, keyed by tool_use_id) so the UI can badge the
      // exact tool result whose hidden content was filtered. The findings are
      // only removed from the map once the message is durably persisted (below),
      // so a duplicate/no-op insert can't consume a badge it never wrote.
      const attachedSanitizations =
        handling.dbType === 'user' && state.toolSanitizations.size > 0
          ? attachToolResultSanitizations(message, state.toolSanitizations)
          : [];

      const id = (message as { uuid?: string }).uuid || uuid();
      const { inserted, sequence } = await insertMessage({
        sessionId,
        id,
        type: handling.dbType,
        content: message,
      });
      if (inserted) {
        for (const toolUseId of attachedSanitizations) state.toolSanitizations.delete(toolUseId);
      }
      if (sequence !== undefined) nextPartialSequence = sequence + 1;
    }
    log.info('runSessionLoop: stream ended', { sessionId });
  } catch (err) {
    log.error('runSessionLoop: error', toError(err), { sessionId });
    await createErrorMessage(sessionId, `Claude query failed: ${toError(err).message}`);
  } finally {
    clearLiveStatus(sessionId, state);
    if (state.pendingInput) {
      state.pendingInput.reject(new Error('Query ended'));
      state.pendingInput = null;
    }
    // Drop the live query handle so the next interaction re-establishes (resume).
    // Keep the state record in the map (commands etc. persist); only stop/delete
    // remove it entirely. The `=== q` guard skips this when a newer query has
    // already re-established (so we never tear down the live one).
    if (state.query === q) {
      state.query = null;
      state.input = null;
      // This query's CLI subprocess is gone (the loop only exits on error / stream
      // end / close), so stop its scope to reap anything it left running (incl.
      // daemons the agent backgrounded). Also clears the name so a re-establish's
      // fresh scope isn't orphaned. stopSession already handled this on the stop
      // path (sessionScope nulled → this is a no-op there).
      if (state.sessionScope) {
        void stopSessionScope(state.sessionScope);
        void persistSessionScope(sessionId, null);
        state.sessionScope = null;
      }
    }
  }
}

/**
 * Establish a fresh streaming query for a session: load settings, build the input
 * channel + options, start the SDK query and its output loop. Resumes prior
 * history when the session already has messages.
 */
async function establishSessionQuery(
  sessionId: string,
  state: SessionState
): Promise<SessionState> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { repoUrl: true, repoPath: true, claudeModel: true },
  });
  if (!session) {
    throw new Error('Session not found');
  }

  const repoFullName = session.repoUrl ? extractRepoFullName(session.repoUrl) : null;
  const settingsKey = repoFullName ?? '__no_repo__';
  const settings = await loadMergedSessionSettings(settingsKey, session.claudeModel);
  const workingDir = getSessionWorkingDir(sessionId, session.repoPath);

  const shouldResume = (await prisma.message.count({ where: { sessionId } })) > 0;
  const options = await buildSdkOptions({ sessionId, workingDir, settings, shouldResume, state });

  // If `stopSession` ran while we were loading (it deletes the map entry), abort
  // before creating the query — otherwise we'd resurrect a torn-down session with
  // an orphan live query. This check and the attach below are await-free, so they
  // run atomically with respect to a synchronous stopSession.
  if (sessions.get(sessionId) !== state) {
    throw new Error('Session establishment cancelled: session was stopped during establish');
  }

  state.workingDir = workingDir;
  state.boundSettings = settings;
  state.settingsKey = settingsKey;

  const input = createPushable<SDKUserMessage>();
  const q = queryFactory({ prompt: input.iterable, options });
  state.input = input;
  state.query = q;

  log.info('Established session query', { sessionId, workingDir, shouldResume });

  // Fetch rich command metadata once (init message may arrive first; merge both).
  void q
    .supportedCommands()
    .then((commands) => {
      state.commands = mergeSlashCommands(
        commands,
        state.commands.map((c) => c.name)
      );
      persistedCommands.set(sessionId, state.commands);
      sseEvents.emitCommands(sessionId, state.commands);
    })
    .catch((err) => {
      log.debug('Failed to fetch supportedCommands', { sessionId, error: toError(err).message });
    });

  void runSessionLoop(sessionId, state, q);

  return state;
}

/**
 * Ensure a live streaming query exists for a session, establishing one lazily
 * (with `resume`) if needed. Idempotent and coalesced: concurrent callers share a
 * single establishment. This is the "resume as needed" recovery path after a
 * server restart or a fatal query error.
 */
export function ensureSessionQuery(sessionId: string): Promise<SessionState> {
  const existing = sessions.get(sessionId);
  if (existing?.query) return Promise.resolve(existing);
  if (existing?.establishing) return existing.establishing;

  const state = getSessionState(sessionId, existing?.workingDir ?? '');
  // Establish against THIS state object; the promise is identity-checked on clear
  // so a stop+revive race never nulls a newer establishment's promise.
  const establishing: Promise<SessionState> = establishSessionQuery(sessionId, state).finally(
    () => {
      const current = sessions.get(sessionId);
      if (current && current.establishing === establishing) current.establishing = null;
    }
  );
  state.establishing = establishing;
  return establishing;
}

/**
 * Apply settings changes that the SDK supports live (model, MCP servers) to an
 * already-running query, so editing repo/global settings takes effect on the next
 * turn without a Stop→Start. `env`/`systemPrompt` are bound at construction and
 * still require a restart (documented). Best-effort: failures are logged, not fatal.
 */
async function applyLiveSettings(sessionId: string, state: SessionState): Promise<void> {
  if (!state.query || !state.boundSettings) return;
  let settings: MergedSessionSettings;
  try {
    // Re-read the per-session model override too, so changing it (via
    // sessions.setModel) applies live on the next turn like repo/global changes.
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { claudeModel: true },
    });
    settings = await loadMergedSessionSettings(state.settingsKey, session?.claudeModel);
  } catch (err) {
    log.debug('applyLiveSettings: failed to load settings', {
      sessionId,
      error: toError(err).message,
    });
    return;
  }

  const bound = state.boundSettings;
  try {
    if (settings.claudeModel !== bound.claudeModel) {
      await state.query.setModel(settings.claudeModel);
      log.info('Applied live model change', { sessionId, model: settings.claudeModel });
    }
    if (!mcpServersEqual(bound.mcpServers, settings.mcpServers)) {
      await state.query.setMcpServers(buildMcpServersRecord(settings.mcpServers) ?? {});
      log.info('Applied live MCP server change', { sessionId });
    }
    state.boundSettings = settings;
  } catch (err) {
    log.warn('applyLiveSettings: failed to apply', { sessionId, error: toError(err).message });
  }
}

/**
 * Send a single user prompt. It is persisted and pushed into the session's
 * streaming query **immediately**, whatever the agent is doing — the CLI folds a
 * mid-turn message into the running turn at the next tool-result boundary, so a
 * "btw, also…" lands in seconds instead of waiting for the agent to go idle. The
 * server never holds messages back.
 *
 * The push is stamped with a `uuid` so the CLI reports its delivery over
 * `command_lifecycle`; until it reports the command started, the message sits in
 * {@link SessionState.pendingCommands} (marked undelivered in the transcript, and
 * cancellable by Stop).
 *
 * `attachments` are stored names (see /api/upload), resolved to paths here.
 */
export async function sendUserMessage(
  sessionId: string,
  prompt: string,
  attachments: string[] = []
): Promise<void> {
  const state = await ensureSessionQuery(sessionId);
  if (!state.input) {
    throw new Error('Session query is not available');
  }

  // Apply model/MCP changes made since the query was built (no-op on fresh establish).
  await applyLiveSettings(sessionId, state);
  await bumpSessionActivity(sessionId);

  // Sanitize/resolve up front (no side effects) so a failure aborts cleanly before
  // anything is persisted and the client keeps the just-typed text to retry.
  const prepared = await prepareUserMessage(sessionId, prompt, attachments);
  if (!state.input) throw new Error('Session query is not available');

  const messageId = uuid();
  const commandUuid = uuid();
  await insertPreparedMessage(sessionId, messageId, prepared);
  state.pendingCommands.set(commandUuid, { messageId, text: prompt });
  sseEvents.emitPendingMessages(sessionId, pendingMessageIds(state));
  // Optimistically mark the turn active. The SDK's own top-level `message_start`
  // confirms it, but setting it here keeps the reducer's true→false edge — and so
  // the work-complete signal — intact for a turn that somehow reaches its
  // terminal `result` without one.
  if (!state.status.turnActive) {
    state.status = { ...state.status, turnActive: true };
  }
  syncRunning(sessionId, state);

  state.input.push({
    type: 'user',
    message: { role: 'user', content: prepared.content },
    parent_tool_use_id: null,
    uuid: commandUuid as SDKUserMessage['uuid'],
  });
}

/** Transcript ids of a session's not-yet-delivered messages (seeds the client). */
export function getPendingMessageIds(sessionId: string): string[] {
  const state = sessions.get(sessionId);
  return state ? pendingMessageIds(state) : [];
}

/**
 * Resolve a still-parked AskUserQuestion / ExitPlanMode tool call so the SDK
 * continues the current turn. Only the in-memory parked promise can do this; once
 * the query has ended the caller must fall back to a new turn (see
 * `submitToolResponse` in the claude router).
 *
 * @returns true if the live promise was resolved, false if there was none.
 */
export async function submitLiveToolResponse(
  sessionId: string,
  toolUseId: string,
  response: ToolResponse,
  waitMs = 3000
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const state = sessions.get(sessionId);
    const pending = state?.pendingInput;

    if (pending && pending.toolUseId === toolUseId) {
      state!.pendingInput = null;
      log.info('submitLiveToolResponse: resolving live tool call', {
        sessionId,
        toolName: pending.toolName,
      });
      pending.resolve(buildPermissionResult(response, pending.input));
      await bumpSessionActivity(sessionId);
      return true;
    }

    // A live promise can only appear while the query is alive. If there is no live
    // query (ended / stopped / server restarted), nothing will ever park.
    if (!state?.query || Date.now() >= deadline) {
      return false;
    }
    await sleep(150);
  }
}

/**
 * Persist a synthetic `tool_result` for a tool_use whose query has ended, so the
 * UI pairs the dangling block and stops showing answer controls. Idempotent via a
 * deterministic id derived from the tool_use id.
 *
 * @returns true if a result was written, false if this tool call was already answered.
 */
export async function persistSyntheticToolResult(
  sessionId: string,
  toolUseId: string,
  text: string
): Promise<boolean> {
  const id = uuidv5(`${sessionId}:tool_result:${toolUseId}`, ERROR_LINE_NAMESPACE);
  const content = buildSyntheticToolResultContent({ sessionId, toolUseId, uuid: id, text });
  const { inserted } = await insertMessage({ sessionId, id, type: 'user', content });
  if (!inserted) {
    log.debug('persistSyntheticToolResult: tool call already answered', { sessionId, toolUseId });
  }
  return inserted;
}

/**
 * Get cached slash commands for a session.
 */
export function getSessionCommands(sessionId: string): SlashCommand[] {
  return persistedCommands.get(sessionId) ?? sessions.get(sessionId)?.commands ?? [];
}

/**
 * Current API-retry status for a session, or null. In-memory only.
 */
export function getSessionRetry(sessionId: string): RetryState | null {
  return sessions.get(sessionId)?.status.retry ?? null;
}

/**
 * Current running background tasks for a session. In-memory only.
 */
export function getSessionBackgroundTasks(sessionId: string): BackgroundTask[] {
  const state = sessions.get(sessionId);
  return state ? [...state.status.backgroundTasks.values()] : [];
}

export interface InterruptResult {
  interrupted: boolean;
  /** Text of the prompts Stop pulled back before the agent ever read them. */
  cancelled: string[];
}

/**
 * `Query.cancelAsyncMessage` drops a pushed user message from the CLI's command
 * queue by uuid, resolving false if it had already been dequeued for execution.
 * It exists at runtime but is missing from the SDK's `Query` type
 * (`@anthropic-ai/claude-agent-sdk` 0.3.219), so it is reached through this
 * narrowing — feature-detected, so an SDK release without it degrades to "Stop
 * doesn't cancel" rather than throwing.
 */
interface CancelCapableQuery {
  cancelAsyncMessage(messageUuid: string): Promise<boolean>;
}

function asCancelCapable(query: Query): CancelCapableQuery | null {
  const candidate = query as Partial<CancelCapableQuery>;
  return typeof candidate.cancelAsyncMessage === 'function'
    ? (candidate as CancelCapableQuery)
    : null;
}

/** Delete a persisted message and tell connected clients to drop it. */
async function removeMessage(sessionId: string, messageId: string): Promise<void> {
  const { count } = await prisma.message.deleteMany({ where: { id: messageId, sessionId } });
  if (count > 0) sseEvents.emitMessageRemoved(sessionId, messageId);
}

/**
 * Pull back every message we pushed that the agent hasn't read yet.
 *
 * Stop has to mean stop: the SDK otherwise runs a still-queued message as its own
 * turn the instant the interrupt lands (verified: `scripts/spike-interrupt-queued.ts`).
 * A command the CLI has already dequeued can't be recalled — `cancelAsyncMessage`
 * reports false and we leave it alone, bubble included, because the agent did read
 * it. A cancelled one is deleted from the transcript (it describes something that
 * never happened) and handed back so the composer can restore the user's text.
 */
async function cancelPendingCommands(
  sessionId: string,
  state: SessionState,
  query: Query
): Promise<string[]> {
  const canceller = state.pendingCommands.size > 0 ? asCancelCapable(query) : null;
  if (!canceller) return [];

  const cancelled: string[] = [];
  for (const [commandUuid, pending] of [...state.pendingCommands]) {
    let dropped = false;
    try {
      dropped = await canceller.cancelAsyncMessage(commandUuid);
    } catch (err) {
      log.warn('interruptClaude: cancelAsyncMessage failed', {
        sessionId,
        error: toError(err).message,
      });
    }
    if (!dropped) continue;
    state.pendingCommands.delete(commandUuid);
    cancelled.push(pending.text);
    await removeMessage(sessionId, pending.messageId);
  }

  if (cancelled.length > 0) {
    sseEvents.emitPendingMessages(sessionId, pendingMessageIds(state));
    syncRunning(sessionId, state);
  }
  return cancelled;
}

/**
 * Interrupt the active turn (streaming-only) and pull back anything the user sent
 * that the agent hasn't read yet. The query stays alive; the SDK emits a terminal
 * `result` (confirmed by the spike + e2e) which the loop maps to
 * `turnActive = false` — no timer involved.
 *
 * If a (hypothetical) interrupt never yielded a result, `turnActive` is cleared by
 * the deterministic, user-driven escape instead of a timer: the header Stop
 * (`sessions.stop`) closes the query → the loop `finally` forces the flag off.
 */
export async function interruptClaude(sessionId: string): Promise<InterruptResult> {
  const state = sessions.get(sessionId);
  if (!state?.query || !effectiveRunning(state)) {
    log.info('interruptClaude: nothing to interrupt', { sessionId });
    return { interrupted: false, cancelled: [] };
  }

  // Mark this turn-end as an interrupt so `applyStatus` doesn't report it as
  // Claude *finishing* — the user stopped it.
  state.interruptRequested = true;

  try {
    await state.query.interrupt();
  } catch (err) {
    // The interrupt didn't take, so no interrupt-driven turn-end is coming; clear
    // the flag so it can't suppress a later, natural turn-end's notification.
    state.interruptRequested = false;
    log.warn('interruptClaude: failed', { sessionId, error: toError(err).message });
    return { interrupted: false, cancelled: [] };
  }

  return {
    interrupted: true,
    cancelled: await cancelPendingCommands(sessionId, state, state.query),
  };
}

/**
 * Stop a single running background task via the SDK, then optimistically remove
 * it from the live set so the ✕ button is reliable whether or not the task is
 * still alive.
 *
 * A live task settles via `query.stopTask`, which makes the SDK emit a terminal
 * `task_notification` — but that notification can be dropped (the SDK occasionally
 * does), and a *phantom* (a task whose terminal notification was already dropped)
 * has no live counterpart for `stopTask` to settle at all. In both cases waiting
 * on the notification would leave the indicator stuck. So we drop the entry from
 * the in-memory set ourselves regardless of `stopTask`'s outcome. If the task was
 * real and the notification does arrive later, the reducer's removal is a harmless
 * no-op (it guards on the task still being present).
 *
 * Idempotent: `success` means the post-condition holds — the task is not (or no
 * longer) in the live set for a session we could act on — so repeat calls (e.g. a
 * double-clicked ✕, or stopping an already-settled task) all return `true`. The
 * SSE emit, by contrast, only fires when an entry was actually removed
 * (`dropBackgroundTask`), so a no-op call stays silent. `false` is returned only
 * when there is no live session state to act on at all.
 */
export async function stopBackgroundTask(sessionId: string, taskId: string): Promise<boolean> {
  const state = sessions.get(sessionId);
  if (!state) return false;

  try {
    await state.query?.stopTask(taskId);
  } catch (err) {
    // A throw typically means the SDK no longer knows this task (already settled,
    // or a phantom). Fall through and clear the indicator anyway.
    log.warn('stopBackgroundTask: stopTask failed; clearing indicator anyway', {
      sessionId,
      taskId,
      error: toError(err).message,
    });
  }

  // Drop the entry (emits only if it was present); report success regardless so
  // the operation is idempotent.
  dropBackgroundTask(sessionId, state, taskId);
  return true;
}

/**
 * Whether the session is working from the composer's point of view — a live turn,
 * or a message the agent hasn't picked up yet ({@link effectiveRunning}).
 */
export function isClaudeRunning(sessionId: string): boolean {
  const state = sessions.get(sessionId);
  return state ? effectiveRunning(state) : false;
}

/**
 * Apply live settings (model / MCP servers) to a session's running query now, if
 * one exists. Used after persisting a per-session model change so it takes effect
 * without waiting for the next send. A no-op when the session has no live query —
 * the change is picked up on the next establish/send anyway. Best-effort.
 */
export async function refreshSessionSettings(sessionId: string): Promise<void> {
  const state = sessions.get(sessionId);
  if (!state?.query) return;
  await applyLiveSettings(sessionId, state);
}

/**
 * Whether any background task with a knowable end state (subagent / Monitor /
 * workflow — NOT a permanently-backgroundable Bash daemon) is running for a session
 * (in-memory check). Independent of {@link isClaudeRunning}: the main turn can be
 * idle while a background task keeps running. See {@link taskHasEndState}.
 */
export function isSessionBackgroundActive(sessionId: string): boolean {
  const state = sessions.get(sessionId);
  return state ? backgroundActive(state.status) : false;
}

/**
 * Mark the last main-agent message as interrupted and append an interrupt marker.
 * Targets the last assistant/result message (skipping interleaved background and
 * system task messages, which can otherwise be the highest-sequence row).
 */
export async function markLastMessageAsInterrupted(sessionId: string): Promise<void> {
  log.info('markLastMessageAsInterrupted', { sessionId });

  const lastMainMessage = await prisma.message.findFirst({
    where: { sessionId, type: { in: ['assistant', 'result'] } },
    orderBy: { sequence: 'desc' },
    select: { id: true, sequence: true, type: true, content: true },
  });

  if (lastMainMessage) {
    try {
      const content = JSON.parse(lastMainMessage.content);
      content.interrupted = true;
      await prisma.message.update({
        where: { id: lastMainMessage.id },
        data: { content: JSON.stringify(content) },
      });
      sseEvents.emitNewMessage(sessionId, {
        id: lastMainMessage.id,
        sessionId,
        sequence: lastMainMessage.sequence,
        type: lastMainMessage.type,
        content,
        createdAt: new Date(),
      });
    } catch (err) {
      log.warn('Failed to mark message as interrupted', {
        sessionId,
        error: toError(err).message,
      });
    }
  }

  await insertMessage({
    sessionId,
    id: uuid(),
    type: 'user',
    content: { type: 'user', subtype: 'interrupt', content: 'Interrupted' },
  });
}

/**
 * Stop a session's query and clear in-memory state. Removes the session from the
 * active map (no lazy revive until the next explicit interaction).
 */
export function stopSession(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (!state) return;

  state.input?.close();
  try {
    state.query?.close();
  } catch {
    // ignore close errors
  }
  // Closing the query kills the launcher/systemd-run process, but a stopped scope
  // is what actually cgroup-kills the session's whole tree (incl. daemons the
  // agent backgrounded), so stop it explicitly. Fire-and-forget; idempotent.
  if (state.sessionScope) {
    void stopSessionScope(state.sessionScope);
    void persistSessionScope(sessionId, null);
    state.sessionScope = null;
  }
  if (state.pendingInput) {
    state.pendingInput.reject(new Error('Session stopped'));
    state.pendingInput = null;
  }
  clearLiveStatus(sessionId, state);
  state.query = null;
  state.input = null;
  sessions.delete(sessionId);
}

/**
 * Clean up all in-memory state for a session, including persisted commands.
 * Called when a session is archived/deleted.
 */
export function cleanupSession(sessionId: string): void {
  stopSession(sessionId);
  persistedCommands.delete(sessionId);
}

/**
 * Stop all active Claude queries. Called during graceful shutdown.
 */
export async function stopAllSessions(): Promise<void> {
  const sessionIds = [...sessions.keys()];
  if (sessionIds.length === 0) return;

  log.info('Stopping all active sessions for shutdown', { count: sessionIds.length });
  // Capture scope names before stopSession clears them, then AWAIT the cgroup
  // stops (stopSession's own scope-stop is fire-and-forget, which shutdown would
  // exit before) so a graceful restart doesn't leave scopes running.
  const scopes = sessionIds
    .map((id) => sessions.get(id)?.sessionScope)
    .filter((s): s is string => Boolean(s));
  for (const id of sessionIds) {
    stopSession(id);
  }
  await Promise.allSettled(scopes.map((scope) => stopSessionScope(scope)));
  // stopSession's per-session DB clear is fire-and-forget and would race
  // process.exit; await one bulk clear so a graceful restart genuinely reaps
  // nothing (a missed clear is only a harmless no-op reap, but this keeps the DB
  // honest across clean restarts).
  if (scopes.length > 0) {
    try {
      await prisma.session.updateMany({
        where: { sessionScope: { in: scopes } },
        data: { sessionScope: null },
      });
    } catch (err) {
      log.debug('stopAllSessions: failed to clear recorded scopes', {
        error: toError(err).message,
      });
    }
  }
}

/**
 * Reap systemd scopes orphaned by a previous crash (which never ran teardown).
 * Called once at startup, before any session revives into a fresh scope. Reaps
 * EXACTLY the scope unit names recorded on session rows — never a `clawed-*`
 * glob — so it can only ever touch scopes THIS deployment created (recorded in
 * its own DB), never a concurrent instance's or a test's sessions. The old broad
 * glob sweep would cgroup-kill any co-tenant instance's live sessions; this
 * cannot. Clears the recorded names once stopped so a clean next boot reaps
 * nothing. Best-effort.
 */
export async function reapOrphanedSessionScopes(): Promise<void> {
  let rows: { sessionScope: string | null }[];
  try {
    rows = await prisma.session.findMany({
      where: { sessionScope: { not: null } },
      select: { sessionScope: true },
    });
  } catch (err) {
    log.error('reapOrphanedSessionScopes: failed to load recorded scopes', toError(err));
    return;
  }
  const scopes = rows.map((r) => r.sessionScope).filter((s): s is string => Boolean(s));
  if (scopes.length === 0) return;

  log.info('Reaping orphaned session scopes on startup', { count: scopes.length });
  await reapSessionScopes(scopes);

  // Clear exactly the names we just reaped — not a blanket `sessionScope != null`
  // — so if a session ever recorded a fresh live scope between the findMany and
  // here, we never null a name still in use (which would leak that live scope on
  // the next crash). Safe today given "runs once before any revive", robust if
  // that invariant ever weakens.
  try {
    await prisma.session.updateMany({
      where: { sessionScope: { in: scopes } },
      data: { sessionScope: null },
    });
  } catch (err) {
    log.debug('reapOrphanedSessionScopes: failed to clear recorded scopes', {
      error: toError(err).message,
    });
  }
}
