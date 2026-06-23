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
  INITIAL_LIVE_STATUS,
  type LiveStatus,
  type BackgroundTask,
} from '@/lib/session-status';
import { createPushable, type Pushable } from '@/lib/pushable';
import { type ToolResponse, buildSyntheticToolResultContent } from '@/lib/tool-response';
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
import { PARTIAL_MESSAGE_ID_PREFIX } from '@/lib/message-cache';
import type { ContainerEnvVar } from './repo-settings';

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

/** Number of times to retry sequence assignment when a concurrent insert wins the race. */
const SEQUENCE_RETRY_LIMIT = 5;

/**
 * How long a turn may go with no message at all before the watchdog assumes it is
 * wedged (the SDK should emit exactly one terminal `result` per turn; this is the
 * safety net for a no-op/hung turn that would otherwise leave `turnActive` stuck).
 */
const TURN_WATCHDOG_MS = 5 * 60_000;

/**
 * How long a session may sit fully idle (no active turn, no background tasks, no
 * parked question) before its streaming query is closed to free the subprocess.
 * The session stays `running` in the DB and is revived (with `resume`) on the next
 * interaction. MUST never reap while a background task is live, or we'd kill a
 * waiter — the whole point of the persistent query.
 */
const IDLE_REAP_MS = 30 * 60_000;

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
  /** Inactivity watchdog for the current turn (cleared when no turn is active). */
  turnWatchdog: ReturnType<typeof setTimeout> | null;
  /** Idle reaper that closes the query after a fully-idle period (revivable). */
  idleReaper: ReturnType<typeof setTimeout> | null;
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
 * Insert a message with the next per-session sequence, retrying on sequence
 * collision. Distinguishes a true duplicate (same `id` already present → returns
 * `inserted: false`) from a `(sessionId, sequence)` race against a concurrent
 * insert (recompute and retry, so a real message is never silently dropped).
 * Emits the `new_message` SSE event on success.
 */
async function insertMessage(params: {
  sessionId: string;
  id: string;
  type: 'system' | 'user' | 'assistant' | 'result';
  content: unknown;
}): Promise<{ inserted: boolean; sequence?: number }> {
  const { sessionId, id, type, content } = params;
  const contentJson = JSON.stringify(content);

  for (let attempt = 0; attempt < SEQUENCE_RETRY_LIMIT; attempt++) {
    const last = await prisma.message.findFirst({
      where: { sessionId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    const sequence = (last?.sequence ?? -1) + 1;

    try {
      const message = await prisma.message.create({
        data: { id, sessionId, sequence, type, content: contentJson },
      });
      sseEvents.emitNewMessage(sessionId, {
        id,
        sessionId,
        sequence,
        type,
        content,
        createdAt: message.createdAt,
      });
      return { inserted: true, sequence };
    } catch (err) {
      if (!(err && typeof err === 'object' && 'code' in err && err.code === 'P2002')) {
        throw err;
      }
      // Unique violation: distinguish a duplicate id (idempotent no-op) from a
      // sequence race (different id collided) — only the latter should retry.
      const existing = await prisma.message.findUnique({ where: { id }, select: { id: true } });
      if (existing) {
        log.debug('insertMessage: duplicate id, skipping', { sessionId, id });
        return { inserted: false };
      }
      log.debug('insertMessage: sequence collision, retrying', { sessionId, attempt });
    }
  }

  throw new Error(
    `Failed to insert message ${id} for ${sessionId} after ${SEQUENCE_RETRY_LIMIT} attempts`
  );
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
      turnWatchdog: null,
      idleReaper: null,
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
 * Build the environment variables to pass to the Claude SDK.
 *
 * Starts with a fresh login shell's environment, then overlays the global Claude
 * API key and finally the user-configured env vars (highest precedence).
 */
export async function buildAgentEnv(
  userEnvVars: ContainerEnvVar[],
  claudeApiKey?: string | null
): Promise<Record<string, string | undefined>> {
  const baseEnv = await getBaseEnv();
  const agentEnv: Record<string, string | undefined> = { ...baseEnv };

  if (claudeApiKey) {
    agentEnv['CLAUDE_CODE_OAUTH_TOKEN'] = claudeApiKey;
  }

  for (const { name, value } of userEnvVars) {
    agentEnv[name] = value;
  }

  return agentEnv;
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
    settingSources: ['project'],
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

  return options;
}

/** Clear the turn watchdog timer. */
function clearTurnWatchdog(state: SessionState): void {
  if (state.turnWatchdog) {
    clearTimeout(state.turnWatchdog);
    state.turnWatchdog = null;
  }
}

/**
 * (Re)arm the inactivity watchdog while a turn is active. Each processed message
 * resets it; if it fires, the turn is assumed wedged and `turnActive` is forced
 * off so the composer is not stuck disabled forever.
 */
function bumpTurnWatchdog(sessionId: string, state: SessionState): void {
  clearTurnWatchdog(state);
  if (!state.status.turnActive) return;
  state.turnWatchdog = setTimeout(() => {
    log.warn('Turn watchdog fired: forcing turnActive off', { sessionId });
    if (state.status.turnActive) {
      state.status = { ...state.status, turnActive: false };
      sseEvents.emitClaudeRunning(sessionId, false);
    }
    void createErrorMessage(
      sessionId,
      'The current turn stopped responding and was marked complete. You can send another message.'
    );
  }, TURN_WATCHDOG_MS);
}

/** Whether a session is fully idle: no active turn, no background tasks, no parked question. */
function isFullyIdle(state: SessionState): boolean {
  return !state.status.turnActive && state.status.backgroundTasks.size === 0 && !state.pendingInput;
}

/**
 * (Re)arm the idle reaper when a session is fully idle, or clear it when not.
 * On fire, the query is closed (subprocess freed); the session stays `running` in
 * the DB and is revived lazily on the next interaction. Never reaps while a
 * background task is live (the guard in {@link isFullyIdle}).
 */
function bumpIdleReaper(sessionId: string, state: SessionState): void {
  if (state.idleReaper) {
    clearTimeout(state.idleReaper);
    state.idleReaper = null;
  }
  if (!state.query || !isFullyIdle(state)) return;
  state.idleReaper = setTimeout(() => {
    const current = sessions.get(sessionId);
    if (current?.query && isFullyIdle(current)) {
      log.info('Reaping idle session query (revivable on next interaction)', { sessionId });
      stopSession(sessionId);
    }
  }, IDLE_REAP_MS);
  state.idleReaper.unref?.();
}

/**
 * Force all live status off and emit only the channels that changed. Used by the
 * loop `finally`, `stopSession`, and shutdown so a torn-down session never leaves
 * a stale "running"/"background"/"retrying" indicator.
 */
function clearLiveStatus(sessionId: string, state: SessionState): void {
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
 * Fold one message into the session's live status and emit changed channels.
 * Runs for EVERY message (including ones that are skipped for persistence, since
 * `api_retry`/`task_*` drive status). Fires per-turn branch/PR detection when a
 * main turn ends.
 */
function applyStatus(sessionId: string, state: SessionState, message: SDKMessage): void {
  const { status, changed } = reduceSessionMessage(state.status, message);
  const turnEnded = changed.turnActive && !status.turnActive;
  state.status = status;

  if (changed.turnActive) sseEvents.emitClaudeRunning(sessionId, status.turnActive);
  if (changed.background) {
    sseEvents.emitBackgroundTasks(sessionId, [...status.backgroundTasks.values()]);
  }
  if (changed.retry) sseEvents.emitClaudeRetry(sessionId, status.retry);

  if (turnEnded) {
    // PR/branch can change within a turn; refresh latest-value state at turn end.
    void detectBranchAndPr(sessionId, state.workingDir);
  }

  // Arm/clear the idle reaper based on the new status (idle → arm; busy → clear).
  bumpIdleReaper(sessionId, state);
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
      bumpTurnWatchdog(sessionId, state);

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

      const id = (message as { uuid?: string }).uuid || uuid();
      const { sequence } = await insertMessage({
        sessionId,
        id,
        type: handling.dbType,
        content: message,
      });
      if (sequence !== undefined) nextPartialSequence = sequence + 1;
    }
    log.info('runSessionLoop: stream ended', { sessionId });
  } catch (err) {
    log.error('runSessionLoop: error', toError(err), { sessionId });
    await createErrorMessage(sessionId, `Claude query failed: ${toError(err).message}`);
  } finally {
    clearTurnWatchdog(state);
    if (state.idleReaper) {
      clearTimeout(state.idleReaper);
      state.idleReaper = null;
    }
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
async function establishSessionQuery(sessionId: string): Promise<SessionState> {
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

  const state = getSessionState(sessionId, workingDir);
  state.boundSettings = settings;
  state.settingsKey = settingsKey;

  const input = createPushable<SDKUserMessage>();
  const options = await buildSdkOptions({ sessionId, workingDir, settings, shouldResume, state });

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
  const establishing = establishSessionQuery(sessionId).finally(() => {
    const current = sessions.get(sessionId);
    if (current) current.establishing = null;
  });
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
 * Send a user prompt: ensure the query is live, apply any live settings changes,
 * mark the turn active optimistically, persist the user message, and push it into
 * the query's input stream.
 */
export async function sendUserMessage(sessionId: string, prompt: string): Promise<void> {
  const state = await ensureSessionQuery(sessionId);
  if (!state.input) {
    throw new Error('Session query is not available');
  }

  // Apply model/MCP changes made since the query was built (no-op on fresh establish).
  await applyLiveSettings(sessionId, state);

  if (!state.status.turnActive) {
    state.status = { ...state.status, turnActive: true };
    sseEvents.emitClaudeRunning(sessionId, true);
  }
  bumpTurnWatchdog(sessionId, state);
  bumpIdleReaper(sessionId, state); // turn active now → clears any pending reaper

  await insertMessage({
    sessionId,
    id: uuid(),
    type: 'user',
    content: { type: 'user', content: prompt },
  });

  state.input.push({
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
  });
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
 * normally emits a terminal `result` which the loop maps to `turnActive = false`.
 * A backstop timer forces it off in case no result arrives.
 */
export async function interruptClaude(sessionId: string): Promise<boolean> {
  const state = sessions.get(sessionId);
  if (!state?.query || !state.status.turnActive) {
    log.info('interruptClaude: no active turn', { sessionId });
    return false;
  }

  try {
    await state.query.interrupt();
  } catch (err) {
    log.warn('interruptClaude: failed', { sessionId, error: toError(err).message });
    return false;
  }

  // Backstop for the pathological case where interrupt never yields a terminal
  // result (the spike shows it reliably does, so this is purely defensive). Kept
  // generous so it does not fire while a long turn is still draining post-interrupt
  // — a premature force-off could let a late stray result clear the NEXT turn.
  setTimeout(() => {
    const current = sessions.get(sessionId);
    if (current?.status.turnActive) {
      log.warn('interruptClaude: no result after interrupt, forcing turnActive off', { sessionId });
      current.status = { ...current.status, turnActive: false };
      sseEvents.emitClaudeRunning(sessionId, false);
      clearTurnWatchdog(current);
    }
  }, 15_000);

  return true;
}

/**
 * Stop a single running background task via the SDK. The terminal
 * `task_notification` that follows removes it from the live set.
 */
export async function stopBackgroundTask(sessionId: string, taskId: string): Promise<boolean> {
  const state = sessions.get(sessionId);
  if (!state?.query) return false;
  try {
    await state.query.stopTask(taskId);
    return true;
  } catch (err) {
    log.warn('stopBackgroundTask: failed', { sessionId, taskId, error: toError(err).message });
    return false;
  }
}

/** Whether a main-agent turn is active for a session (in-memory check). */
export function isClaudeRunning(sessionId: string): boolean {
  return sessions.get(sessionId)?.status.turnActive ?? false;
}

/** Async variant (everything is in-process now). */
export async function isClaudeRunningAsync(sessionId: string): Promise<boolean> {
  return isClaudeRunning(sessionId);
}

/** Whether a live streaming query exists for a session (in-memory check). */
export function hasLiveQuery(sessionId: string): boolean {
  return sessions.get(sessionId)?.query != null;
}

/**
 * Mark the last main-agent message as interrupted and append an interrupt marker.
 * Targets the last assistant/result message (skipping interleaved background and
 * system task messages, which can otherwise be the highest-sequence row).
 */
export async function markLastMessageAsInterrupted(sessionId: string): Promise<void> {
  log.info('markLastMessageAsInterrupted', { sessionId });

  const lastMessage = await prisma.message.findFirst({
    where: { sessionId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  if (!lastMessage) return;

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

  clearTurnWatchdog(state);
  if (state.idleReaper) {
    clearTimeout(state.idleReaper);
    state.idleReaper = null;
  }
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
