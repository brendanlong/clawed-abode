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
import { classifyMessage, SystemInitContentSchema, type RetryState } from '@/lib/claude-messages';
import {
  reduceSessionMessage,
  removeBackgroundTask,
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
import { type SanitizationInfo } from '@/lib/sanitization';
import { attachToolResultSanitizations } from '@/lib/message-sanitization';
import { PARTIAL_MESSAGE_ID_PREFIX } from '@/lib/message-cache';
import type { ContainerEnvVar } from './repo-settings';
import { resolveUploadPaths } from './uploads';
import { MAX_QUEUED_MESSAGES, type QueuedMessage } from '@/lib/queued-message';

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
   * User messages sent while a main-agent turn was active (async "btw mode"),
   * awaiting flush into a single combined turn when the turn ends. Unlike the
   * old design these are NOT persisted while queued — they live only here and are
   * surfaced to the client over the `queued` SSE channel, so the user can ✕-remove
   * one before it sends (see {@link cancelQueuedMessage}). Persisted (as separate
   * transcript bubbles) only when they flush. In-memory only — lost on stop/restart
   * before flush (nothing lingers in the transcript because nothing was persisted).
   */
  queuedMessages: QueuedMessage[];
  /**
   * Set by {@link interruptClaude} so the turn-end it triggers does NOT flush the
   * queue: an interrupt must leave queued messages sitting (removable), never fire
   * them as a fresh turn the instant the user hit Stop. Consumed (cleared) by the
   * turn-end in {@link applyStatus}.
   */
  interruptRequested: boolean;
  /**
   * True between flushing queued messages and the flushed turn's `message_start`.
   * While set, `applyStatus` suppresses the just-ended turn's `turnActive` clear
   * (and its trailing `result`) so the flag stays continuously true across the
   * handoff — no idle blip, no spurious "turn ended" side effects (work-complete
   * notification, voice auto-read reset) between back-to-back queued turns.
   */
  awaitingFlushTurn: boolean;
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
      queuedMessages: [],
      interruptRequested: false,
      awaitingFlushTurn: false,
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
  if (mcpServersRecord && Object.keys(mcpServersRecord).length > 0) {
    options.mcpServers = mcpServersRecord;
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

  return options;
}

/**
 * Force all live status off and emit only the channels that changed. Used by the
 * loop `finally`, `stopSession`, and shutdown so a torn-down session never leaves
 * a stale "running"/"background"/"retrying" indicator.
 */
function clearLiveStatus(sessionId: string, state: SessionState): void {
  // A pending flush is abandoned when the query tears down; drop any queued
  // messages and the handoff flag so a revived query starts clean. Emit the empty
  // queue so the client's indicator clears too (they were never persisted).
  state.awaitingFlushTurn = false;
  state.interruptRequested = false;
  if (state.queuedMessages.length > 0) {
    state.queuedMessages = [];
    sseEvents.emitQueuedMessages(sessionId, []);
  }
  if (state.status.turnActive) {
    state.status = { ...state.status, turnActive: false };
    sseEvents.emitClaudeRunning(sessionId, false);
  }
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
  const next = removeBackgroundTask(state.status.backgroundTasks, taskId);
  if (next === state.status.backgroundTasks) return false;
  state.status = { ...state.status, backgroundTasks: next };
  sseEvents.emitBackgroundTasks(sessionId, [...next.values()]);
  return true;
}

/**
 * Whether a message is the main agent's (top-level) `message_start` — the
 * definitive signal that a new turn has begun. Used to close the flush-handoff
 * suppression window (see {@link applyStatus}); it can't be inferred from the
 * reducer's `changed.turnActive` there, because the flag is being held true
 * across the handoff so the reducer sees no transition.
 */
function isTopLevelMessageStart(message: SDKMessage): boolean {
  if (message.type !== 'stream_event') return false;
  const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  if (parent !== null && parent !== undefined) return false;
  const event = (message as { event?: { type?: string } }).event;
  return event?.type === 'message_start';
}

/** A user message that has been resolved + sanitized but not yet persisted. */
interface PreparedMessage {
  content: string;
  sanitization?: SanitizationInfo;
}

/**
 * Resolve attachments, build the attachment prefix, and sanitize — with **no DB
 * writes or other side effects**, so a prepared message can be safely discarded if
 * the delivery is aborted (an interrupt or teardown landing during the async
 * window). This separation is what keeps the flush/idle-send paths non-destructive:
 * the expensive/failure-prone work (fs, sanitizer) happens before anything is
 * committed, so on abort the queued messages can just be handed back untouched.
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

/** Persist a prepared message as its own transcript bubble. */
function insertPreparedMessage(sessionId: string, prepared: PreparedMessage) {
  return insertMessage({
    sessionId,
    id: uuid(),
    type: 'user',
    content: {
      type: 'user',
      content: prepared.content,
      ...(prepared.sanitization ? { sanitization: prepared.sanitization } : {}),
    },
  });
}

/**
 * Put messages back at the front of the queue (order preserved) and re-emit, so an
 * aborted flush/idle-send (interrupt, teardown, or a persist error) never silently
 * loses the user's queued messages. No-op for an empty list.
 */
function requeueMessages(sessionId: string, state: SessionState, messages: QueuedMessage[]): void {
  if (messages.length === 0) return;
  state.queuedMessages = [...messages, ...state.queuedMessages];
  sseEvents.emitQueuedMessages(sessionId, state.queuedMessages);
}

/**
 * End a flush handoff without a flushed turn: clear the handoff/interrupt flags and
 * drop `turnActive` to idle, emitting the change. Used when a flush is aborted
 * (interrupt landed, query torn down, or a persist error) so the composer isn't
 * left pinned "working".
 */
function endFlushHandoff(sessionId: string, state: SessionState): void {
  state.awaitingFlushTurn = false;
  state.interruptRequested = false;
  if (state.status.turnActive) {
    state.status = { ...state.status, turnActive: false };
    sseEvents.emitClaudeRunning(sessionId, false);
  }
}

/**
 * Flush messages queued while the main agent was busy into a single new turn.
 * Called (fire-and-forget) when the turn ends naturally — the caller captures and
 * clears the queue synchronously; this delivers them ("btw mode": Claude addresses
 * them together). The SDK picking up the push drives `turnActive` back to true via
 * the next `message_start`; we deliberately do NOT toggle it here, and
 * `awaitingFlushTurn` bridges the gap so there's no idle blip.
 *
 * Robustness: sanitizing/resolving (the failure-prone, side-effect-free work) runs
 * BEFORE any bubble is persisted, so if an interrupt lands in the flush window, or
 * the query is torn down, or preparation throws, the messages are handed back to
 * the queue (never silently lost) and the session goes idle. In particular an
 * interrupt during the window must NOT let the queue fire as a fresh turn — the
 * whole point of leaving queued messages queued on Stop.
 */
async function flushQueuedMessages(
  sessionId: string,
  state: SessionState,
  messages: QueuedMessage[]
): Promise<void> {
  if (messages.length === 0) return;
  log.info('Flushing queued messages into a new turn', { sessionId, count: messages.length });
  try {
    const prepared: PreparedMessage[] = [];
    for (const m of messages) {
      prepared.push(await prepareUserMessage(sessionId, m.text, m.attachments));
    }

    // An interrupt landed during preparation (user hit Stop in the flush window),
    // or the query was torn down: abort — hand the messages back and go idle rather
    // than firing them as a new turn.
    if (state.interruptRequested || !state.input) {
      requeueMessages(sessionId, state, messages);
      endFlushHandoff(sessionId, state);
      return;
    }

    for (const p of prepared) await insertPreparedMessage(sessionId, p);
    if (!state.input) {
      endFlushHandoff(sessionId, state);
      return;
    }
    state.input.push({
      type: 'user',
      message: { role: 'user', content: prepared.map((p) => p.content).join('\n\n') },
      parent_tool_use_id: null,
    });
  } catch (err) {
    log.error('flushQueuedMessages: failed to flush queue', toError(err), { sessionId });
    // Non-destructive: sanitizing has no side effects, so hand the messages back to
    // the queue and go idle. (A DB error mid-persist is rare enough that a possible
    // duplicate bubble on the next flush is preferable to silently losing them.)
    requeueMessages(sessionId, state, messages);
    endFlushHandoff(sessionId, state);
  }
}

/**
 * Fold one message into the session's live status and emit changed channels.
 * Runs for EVERY message (including ones that are skipped for persistence, since
 * `api_retry`/`task_*` drive status). Fires per-turn branch/PR detection when a
 * main turn ends.
 */
function applyStatus(sessionId: string, state: SessionState, message: SDKMessage): void {
  const reduced = reduceSessionMessage(state.status, message);
  let status = reduced.status;
  const changed = { ...reduced.changed };
  // The raw turn-end signal (before flush suppression), used for PR/branch detection.
  const rawTurnEnded = changed.turnActive && !status.turnActive;

  // An interrupt's turn-end must NOT flush the queue — queued messages stay put
  // (removable) instead of firing as a fresh turn the instant the user hit Stop.
  // `interruptRequested` is a one-shot flag set by interruptClaude; consume it here.
  const interrupted = rawTurnEnded && state.interruptRequested;
  if (rawTurnEnded) state.interruptRequested = false;

  // Flush queued messages when the main turn ends naturally (see
  // flushQueuedMessages). Decided before emitting so we can suppress the
  // intervening turnActive clear entirely. `!awaitingFlushTurn` guards against a
  // second flush from the just-ended turn's trailing `result` (which also reports
  // rawTurnEnded while a flush is already in flight) — messages queued during the
  // handoff instead flush at the flushed turn's own natural end.
  const willFlush =
    rawTurnEnded &&
    !interrupted &&
    !state.awaitingFlushTurn &&
    state.queuedMessages.length > 0 &&
    state.input != null;

  // The flushed turn actually beginning (its own top-level message_start) closes
  // the suppression window opened by the flush below.
  if (state.awaitingFlushTurn && isTopLevelMessageStart(message)) {
    state.awaitingFlushTurn = false;
  }

  // Keep turnActive continuously true across a queued-flush handoff: while the
  // flush is pending, ignore the ended turn's clear (and its trailing `result`,
  // plus any interleaved task events) until the flushed turn starts. `changed` is
  // recomputed against the previous status so no spurious SSE toggle is emitted.
  if ((willFlush || state.awaitingFlushTurn) && !status.turnActive) {
    status = { ...status, turnActive: true };
    changed.turnActive = status.turnActive !== state.status.turnActive;
  }

  state.status = status;

  if (changed.turnActive) sseEvents.emitClaudeRunning(sessionId, status.turnActive);
  // A genuine, natural turn completion — the turn cleared to idle here, and it was
  // neither an interrupt (`interrupted`) nor a flush handoff (which forces
  // `status.turnActive` true above). Stop/delete/error teardown goes through
  // clearLiveStatus, which never routes here. This is the "Claude finished" signal
  // the app-level work-complete notifier keys off (distinct from a bare
  // running:false edge, which also fires on interrupt/stop).
  if (changed.turnActive && !status.turnActive && !interrupted) {
    sseEvents.emitClaudeFinished(sessionId);
  }
  if (changed.background) {
    sseEvents.emitBackgroundTasks(sessionId, [...status.backgroundTasks.values()]);
  }
  if (changed.retry) sseEvents.emitClaudeRetry(sessionId, status.retry);

  // PR/branch can change within a turn; refresh at the genuine turn end only
  // (skip the ended turn's trailing `result`, which also reports rawTurnEnded
  // while a flush handoff is in progress).
  if (rawTurnEnded && !state.awaitingFlushTurn) {
    void detectBranchAndPr(sessionId, state.workingDir);
  }
  if (willFlush) {
    // Capture and clear the queue synchronously (emit the empty list so the
    // client drops its queued bubbles), then flush asynchronously — persisting
    // each message as its own bubble and pushing them as one turn.
    const toFlush = state.queuedMessages;
    state.queuedMessages = [];
    sseEvents.emitQueuedMessages(sessionId, []);
    state.awaitingFlushTurn = true;
    void flushQueuedMessages(sessionId, state, toFlush);
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
    // remove it entirely.
    if (state.query === q) {
      state.query = null;
      state.input = null;
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
    select: { repoUrl: true, repoPath: true },
  });
  if (!session) {
    throw new Error('Session not found');
  }

  const repoFullName = session.repoUrl ? extractRepoFullName(session.repoUrl) : null;
  const settingsKey = repoFullName ?? '__no_repo__';
  const settings = await loadMergedSessionSettings(settingsKey);
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
    settings = await loadMergedSessionSettings(state.settingsKey);
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
 * Add a message to the session's queue (a main-agent turn is active) and emit the
 * updated list so the client can render it as a removable queued bubble. NOT
 * persisted — see {@link QueuedMessage}. Throws if the queue is already at
 * {@link MAX_QUEUED_MESSAGES} (pathological), so the send surfaces an error rather
 * than growing an unbounded batch.
 */
function enqueueMessage(
  sessionId: string,
  state: SessionState,
  text: string,
  attachments: string[]
): void {
  if (state.queuedMessages.length >= MAX_QUEUED_MESSAGES) {
    throw new Error(`Too many queued messages (max ${MAX_QUEUED_MESSAGES})`);
  }
  const message: QueuedMessage = { id: uuid(), text, attachments };
  state.queuedMessages = [...state.queuedMessages, message];
  sseEvents.emitQueuedMessages(sessionId, state.queuedMessages);
}

/**
 * Send a single user prompt. The server owns the queue decision (the client never
 * routes based on its own view of the turn state):
 *
 *  - **A main-agent turn is active** → hold the message in the session queue,
 *    surfaced to the client as a removable "queued" bubble; NOT persisted until it
 *    flushes at turn end (see {@link flushQueuedMessages}).
 *  - **Idle** → start a turn now. Any messages still queued (e.g. left sitting
 *    after an interrupt) are flushed ahead of this one, combined into one turn, in
 *    order — so nothing is silently stranded.
 *
 * `attachments` are stored names (see /api/upload), resolved to paths lazily at
 * persist time.
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

  if (state.status.turnActive) {
    enqueueMessage(sessionId, state, prompt, attachments);
    return;
  }

  // Idle: deliver now, draining any leftover queue (e.g. left after an interrupt)
  // ahead of this message so ordering/intent are preserved (queued-then-typed). The
  // queue is cleared before the (awaited) prepare so a concurrent send can't
  // double-drain it; on any failure the leftover is handed back (see below).
  const leftover = state.queuedMessages;
  if (leftover.length > 0) {
    state.queuedMessages = [];
    sseEvents.emitQueuedMessages(sessionId, []);
  }
  const items: QueuedMessage[] = [...leftover, { id: uuid(), text: prompt, attachments }];

  // Sanitize/resolve up front (no side effects) so a failure or a racing turn can
  // abort cleanly before anything is persisted.
  let prepared: PreparedMessage[];
  try {
    prepared = [];
    for (const it of items) {
      prepared.push(await prepareUserMessage(sessionId, it.text, it.attachments));
    }
  } catch (err) {
    // Nothing persisted — hand the leftover back to the queue and surface the error
    // to the caller (the client keeps the just-typed message to retry).
    requeueMessages(sessionId, state, leftover);
    throw err;
  }

  // A turn racing in during prepare (a concurrent send, or a background subagent
  // autonomously continuing the turn) means we must NOT start a second turn — queue
  // these as pending instead, so the SDK isn't handed a new turn mid-generation.
  if (state.status.turnActive || !state.input) {
    requeueMessages(sessionId, state, items);
    if (!state.input) throw new Error('Session query is not available');
    return;
  }

  try {
    for (const p of prepared) await insertPreparedMessage(sessionId, p);
  } catch (err) {
    requeueMessages(sessionId, state, leftover);
    throw err;
  }
  if (!state.input) throw new Error('Session query is not available');
  state.status = { ...state.status, turnActive: true };
  sseEvents.emitClaudeRunning(sessionId, true);
  state.input.push({
    type: 'user',
    message: { role: 'user', content: prepared.map((p) => p.content).join('\n\n') },
    parent_tool_use_id: null,
  });
}

/**
 * Remove a single queued message before it flushes (the ✕ on a queued bubble).
 * Emits the updated list. Idempotent: removing an absent id (already flushed or
 * cancelled) is a no-op that still reports success — the post-condition (that id
 * is not queued) holds. Returns false only when there is no live session state.
 */
export function cancelQueuedMessage(sessionId: string, queuedId: string): boolean {
  const state = sessions.get(sessionId);
  if (!state) return false;
  const next = state.queuedMessages.filter((m) => m.id !== queuedId);
  if (next.length !== state.queuedMessages.length) {
    state.queuedMessages = next;
    sseEvents.emitQueuedMessages(sessionId, next);
  }
  return true;
}

/** The messages currently queued for a session (seeds the client; empty if none). */
export function getQueuedMessages(sessionId: string): QueuedMessage[] {
  return sessions.get(sessionId)?.queuedMessages ?? [];
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

/**
 * Interrupt the active turn (streaming-only). The query stays alive; the SDK
 * emits a terminal `result` (confirmed by the spike + e2e) which the loop maps to
 * `turnActive = false` — no timer involved.
 *
 * If a (hypothetical) interrupt never yielded a result, `turnActive` is cleared by
 * the deterministic, user-driven escape instead of a timer: the header Stop
 * (`sessions.stop`) closes the query → the loop `finally` forces the flag off.
 */
export async function interruptClaude(sessionId: string): Promise<boolean> {
  const state = sessions.get(sessionId);
  if (!state?.query || !state.status.turnActive) {
    log.info('interruptClaude: no active turn', { sessionId });
    return false;
  }

  // Close any open flush-handoff suppression window first. An interrupt during
  // the handoff (after queued messages were flushed but before the flushed turn's
  // top-level `message_start`) produces a terminal `result` with no preceding
  // `message_start` — which would never close the window, pinning `turnActive`
  // true and silently killing the composer. Clearing the flag lets that terminal
  // result flow through `applyStatus` and clear `turnActive` normally. Any queued
  // messages already pushed to the SDK are unaffected (they run as their own turn).
  state.awaitingFlushTurn = false;

  // Mark this turn-end as an interrupt so `applyStatus` does NOT flush the queue:
  // stopping Claude must leave queued messages sitting (removable), never fire
  // them as a fresh turn the instant the user hit Stop.
  state.interruptRequested = true;

  try {
    await state.query.interrupt();
  } catch (err) {
    // The interrupt didn't take, so no interrupt-driven turn-end is coming; clear
    // the flag so it can't suppress the flush of a later, natural turn-end.
    state.interruptRequested = false;
    log.warn('interruptClaude: failed', { sessionId, error: toError(err).message });
    return false;
  }

  return true;
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

/** Whether a main-agent turn is active for a session (in-memory check). */
export function isClaudeRunning(sessionId: string): boolean {
  return sessions.get(sessionId)?.status.turnActive ?? false;
}

/** Async variant (everything is in-process now). */
export async function isClaudeRunningAsync(sessionId: string): Promise<boolean> {
  return isClaudeRunning(sessionId);
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
  for (const id of sessionIds) {
    stopSession(id);
  }
}
