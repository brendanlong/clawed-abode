/**
 * Orchestrates one long-lived streaming Claude SDK `query()` per session: lazy
 * establishment with resume, the output loop that persists messages and derives
 * live status, sends, interrupts and teardown. Design and rationale live in
 * doc/claude-sessions.md; invariants in src/server/services/CLAUDE.md.
 *
 * Seams (each independently testable): agent-env (login-shell env), sdk-options
 * (query construction), in-flight-commands (delivery tracking), message-store
 * (persistence), session-commands (slash commands), session-branch-pr (turn-end
 * branch/PR refresh), session-state (the in-memory record).
 */

import {
  query as sdkQuery,
  type Query,
  type Options,
  type PermissionResult,
  type SDKUserMessage,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { v4 as uuid } from 'uuid';
import { prisma } from '@/lib/prisma';
import { classifyMessage, type RetryState } from '@/lib/claude-messages';
import {
  reduceSessionMessage,
  removeBackgroundTask,
  backgroundActive,
  type BackgroundTask,
} from '@/lib/session-status';
import { createPushable } from '@/lib/pushable';
import type { ToolResponse } from '@/lib/tool-response';
import type { CancelledPrompt } from '@/lib/cancelled-prompt';
import { extractRepoFullName } from '@/lib/utils';
import { createLogger, toError } from '@/lib/logger';
import { attachToolResultSanitizations } from '@/lib/message-sanitization';
import { PARTIAL_MESSAGE_ID_PREFIX } from '@/lib/message-cache';
import { sseEvents } from './events';
import { getSessionWorkingDir } from './worktree-manager';
import {
  loadMergedSessionSettings,
  mcpServersEqual,
  type MergedSessionSettings,
} from './settings-merger';
import { StreamAccumulator } from './stream-accumulator';
import { stopSessionScope, reapSessionScopes } from './session-cgroup';
import { createSessionState, type SessionState } from './session-state';
import {
  createErrorMessage,
  bumpSessionActivity,
  insertMessage,
  insertPreparedMessage,
  prepareUserMessage,
  removeMessages,
} from './message-store';
import {
  cancelInFlightCommands,
  effectiveRunning,
  handleCommandLifecycle,
  pendingMessageIds,
  retireInFlightCommands,
  syncRunning,
} from './in-flight-commands';
import {
  forgetSessionCommands,
  getSessionCommands,
  mergeInitCommands,
  mergeSlashCommands,
  rememberSessionCommands,
} from './session-commands';
import { buildMcpServersRecord, buildSdkOptions } from './sdk-options';
import { detectBranchAndPr } from './session-branch-pr';

const log = createLogger('claude-runner');

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

/** Active sessions tracked in memory. */
const sessions = new Map<string, SessionState>();

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

function getSessionState(sessionId: string, workingDir: string): SessionState {
  let state = sessions.get(sessionId);
  if (!state) {
    state = createSessionState(workingDir, getSessionCommands(sessionId));
    sessions.set(sessionId, state);
  } else if (workingDir) {
    state.workingDir = workingDir;
  }
  return state;
}

/**
 * Mirror a session's current systemd scope unit name onto its DB row (or clear it
 * with null on teardown), so a crash — which never runs teardown — leaves the
 * orphaned scope name behind for {@link reapOrphanedSessionScopes}. Best-effort: a
 * failed write only risks a leaked scope after a crash, never correctness.
 * `updateMany` so a deleted session is a silent no-op.
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
  // Deliveries in flight die with the query. Their bubbles stay (they may well
  // have been read), but the "not delivered yet" marker must clear.
  if (state.inFlightCommands.size > 0) {
    state.inFlightCommands.clear();
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
 * `background` channel if it was present. Used by the optimistic-stop path so the
 * indicator clears immediately rather than waiting for a terminal
 * `task_notification` the SDK can drop.
 */
function dropBackgroundTask(sessionId: string, state: SessionState, taskId: string): boolean {
  if (!state.status.backgroundTasks.has(taskId)) return false;
  const next = removeBackgroundTask(state.status.backgroundTasks, taskId);
  state.status = { ...state.status, backgroundTasks: next };
  sseEvents.emitBackgroundTasks(sessionId, [...next.values()]);
  return true;
}

/**
 * Fold one message into the session's live status and emit changed channels.
 * Runs for EVERY message (including ones skipped for persistence, since
 * `api_retry`/`task_*` drive status). Fires the branch/PR refresh at a main-turn end.
 */
function applyStatus(sessionId: string, state: SessionState, message: SDKMessage): void {
  const { status, changed } = reduceSessionMessage(state.status, message);
  const turnEnded = changed.turnActive && !status.turnActive;

  // An interrupt's turn-end is not Claude finishing — the user stopped it.
  const interrupted = turnEnded && state.interruptRequested;
  if (turnEnded) state.interruptRequested = false;

  state.status = status;

  retireInFlightCommands(sessionId, state, message);
  syncRunning(sessionId, state);

  // "Claude finished" = a natural main-turn end that leaves the session fully
  // idle. Why turn-end rather than background-drain, and why not the bare
  // running:false edge: doc/claude-sessions.md, "Claude Finished" Notification.
  if (turnEnded && !interrupted && !backgroundActive(status) && state.inFlightCommands.size === 0) {
    sseEvents.emitClaudeFinished(sessionId);
  }
  if (changed.background) {
    sseEvents.emitBackgroundTasks(sessionId, [...status.backgroundTasks.values()]);
  }
  if (changed.retry) sseEvents.emitClaudeRetry(sessionId, status.retry);

  if (turnEnded) {
    void detectBranchAndPr(sessionId, state.workingDir);
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

      // Attach sanitizer findings for this message's tool results so the UI can
      // badge the exact tool result whose hidden content was filtered. Findings are
      // removed only once the message is durably persisted, so a duplicate/no-op
      // insert can't consume a badge it never wrote.
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
    // The state record stays in the map (commands etc. persist); only stop/delete
    // remove it. The `=== q` guard skips this when a newer query has already
    // re-established, so we never tear down the live one.
    if (state.query === q) {
      state.query = null;
      state.input = null;
      // This query's CLI subprocess is gone, so stop its scope to reap anything it
      // left running. stopSession already nulled the scope on the stop path.
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
  // Record the scope name durably BEFORE the subprocess (and thus the scope) is
  // spawned, so a crash between here and teardown can always reap it by exact
  // name. Over-recording — a name written for a scope that ends up not created
  // because establish aborts below — is harmless: the reap's stop is a no-op.
  if (state.sessionScope) await persistSessionScope(sessionId, state.sessionScope);

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
      rememberSessionCommands(sessionId, state.commands);
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
 * single establishment. This is the recovery path after a server restart or a
 * fatal query error.
 */
function ensureSessionQuery(sessionId: string): Promise<SessionState> {
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
 * Apply the settings the SDK supports changing live (model, MCP servers) to a
 * running query, so edits take effect on the next turn without a Stop→Start.
 * Everything else is bound at construction (doc/settings.md). Best-effort.
 */
async function applyLiveSettings(sessionId: string, state: SessionState): Promise<void> {
  if (!state.query || !state.boundSettings) return;
  let settings: MergedSessionSettings;
  try {
    // Re-read the per-session model override too, so sessions.setModel applies live.
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
 * Send a user prompt: persisted and pushed into the streaming query immediately,
 * whatever the agent is doing (the CLI folds a mid-turn message into the running
 * turn). The push is stamped with a `uuid` so the CLI reports its delivery over
 * `command_lifecycle`; until then it sits in `inFlightCommands`, marked
 * undelivered in the transcript and cancellable by Stop.
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

  await applyLiveSettings(sessionId, state);
  await bumpSessionActivity(sessionId);

  // Sanitize/resolve up front (no side effects) so a failure aborts cleanly before
  // anything is persisted and the client keeps the just-typed text to retry.
  const prepared = await prepareUserMessage(sessionId, prompt, attachments);

  const messageId = uuid();
  const commandUuid = uuid();
  await insertPreparedMessage(sessionId, messageId, prepared);

  // Re-read `state.input` *after* the insert: the query loop can exit mid-await
  // (CLI crash, stop) and null it. Tracking a command we never pushed would strand
  // it in-flight forever, so undo the bubble and surface the failure instead.
  const input = state.input;
  if (!input) {
    await removeMessages(sessionId, [messageId]);
    throw new Error('Session query is not available');
  }

  state.inFlightCommands.set(commandUuid, {
    messageId,
    text: prompt,
    attachments,
    started: false,
    resultsSeen: 0,
  });
  sseEvents.emitPendingMessages(sessionId, pendingMessageIds(state));
  // Optimistically mark the turn active so the reducer's true→false edge — and
  // the work-complete signal — stays intact for a turn that reaches its terminal
  // `result` without a `message_start`.
  if (!state.status.turnActive) {
    state.status = { ...state.status, turnActive: true };
  }
  syncRunning(sessionId, state);

  input.push({
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
 * the query has ended the caller falls back to a new turn (`submitToolResponse`
 * in the claude router).
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

    // A live promise can only appear while the query is alive; the short poll
    // covers an answer racing the SDK's canUseTool call.
    if (!state?.query || Date.now() >= deadline) {
      return false;
    }
    await sleep(150);
  }
}

/** Current API-retry status for a session, or null. In-memory only. */
export function getSessionRetry(sessionId: string): RetryState | null {
  return sessions.get(sessionId)?.status.retry ?? null;
}

/** Current running background tasks for a session. In-memory only. */
export function getSessionBackgroundTasks(sessionId: string): BackgroundTask[] {
  const state = sessions.get(sessionId);
  return state ? [...state.status.backgroundTasks.values()] : [];
}

export interface InterruptResult {
  /**
   * A live main-agent turn was aborted. False when Stop had nothing to abort but
   * still recalled queued messages — the caller must not then mark an
   * already-completed message as interrupted.
   */
  interrupted: boolean;
  /** Prompts Stop pulled back before the agent ever read them. */
  cancelled: CancelledPrompt[];
}

/**
 * Interrupt the active turn and pull back anything the user sent that the agent
 * hasn't read yet. The query stays alive; the SDK emits a terminal `result` which
 * the loop maps to `turnActive = false`. If that never came, the header Stop
 * (closing the query) is the deterministic escape — never a timer.
 */
export async function interruptClaude(sessionId: string): Promise<InterruptResult> {
  const state = sessions.get(sessionId);
  if (!state?.query || !effectiveRunning(state)) {
    log.info('interruptClaude: nothing to interrupt', { sessionId });
    return { interrupted: false, cancelled: [] };
  }

  // Whether there is a turn to abort at all — Stop is also reachable when the only
  // thing "running" is a message the CLI hasn't picked up yet. Read before any
  // await, and reported back so the caller doesn't stamp "Interrupted" on a turn
  // that had already finished.
  const hadActiveTurn = state.status.turnActive;

  // Mark the coming turn-end as an interrupt before the awaits below, so a turn
  // ending naturally while we cancel can't fire a work-complete notification for
  // work the user just cancelled.
  state.interruptRequested = hadActiveTurn;

  // Empty the CLI's command queue first: the abort below wakes its drain loop, and
  // anything still queued at that moment would run as its own turn.
  const cancelled = await cancelInFlightCommands(sessionId, state, state.query);

  try {
    await state.query.interrupt();
  } catch (err) {
    // No interrupt-driven turn-end is coming; clear the flag so it can't suppress
    // a later, natural turn-end's notification.
    state.interruptRequested = false;
    log.warn('interruptClaude: failed', { sessionId, error: toError(err).message });
    return { interrupted: false, cancelled };
  }

  return { interrupted: hadActiveTurn, cancelled };
}

/**
 * Stop a background task via the SDK, then optimistically drop it from the live
 * set so the ✕ is reliable whether or not the task is still alive: the SDK's
 * terminal `task_notification` can be dropped, and a phantom (already-dropped
 * notification) has nothing for `stopTask` to settle. Idempotent — `true` means
 * the task is not (or no longer) tracked for a session we could act on; `false`
 * only when there is no live session state at all. Emits only on actual removal.
 */
export async function stopBackgroundTask(sessionId: string, taskId: string): Promise<boolean> {
  const state = sessions.get(sessionId);
  if (!state) return false;

  try {
    await state.query?.stopTask(taskId);
  } catch (err) {
    log.warn('stopBackgroundTask: stopTask failed; clearing indicator anyway', {
      sessionId,
      taskId,
      error: toError(err).message,
    });
  }

  dropBackgroundTask(sessionId, state, taskId);
  return true;
}

/** Whether the session is working from the composer's point of view. */
export function isClaudeRunning(sessionId: string): boolean {
  const state = sessions.get(sessionId);
  return state ? effectiveRunning(state) : false;
}

/**
 * Apply live settings (model / MCP servers) to a session's running query now, if
 * one exists. A no-op without a live query — the next establish picks them up.
 */
export async function refreshSessionSettings(sessionId: string): Promise<void> {
  const state = sessions.get(sessionId);
  if (!state?.query) return;
  await applyLiveSettings(sessionId, state);
}

/**
 * Whether a background task with a knowable end state is running (in-memory).
 * Independent of {@link isClaudeRunning}; see `taskHasEndState`.
 */
export function isSessionBackgroundActive(sessionId: string): boolean {
  const state = sessions.get(sessionId);
  return state ? backgroundActive(state.status) : false;
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
  // Closing the query kills the launcher, but stopping the scope is what
  // cgroup-kills the whole tree (incl. daemons the agent backgrounded).
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

/** Clean up all in-memory state for a session, including its slash commands (archive/delete). */
export function cleanupSession(sessionId: string): void {
  stopSession(sessionId);
  forgetSessionCommands(sessionId);
}

/** Stop all active Claude queries (graceful shutdown). */
export async function stopAllSessions(): Promise<void> {
  const sessionIds = [...sessions.keys()];
  if (sessionIds.length === 0) return;

  log.info('Stopping all active sessions for shutdown', { count: sessionIds.length });
  // Capture scope names before stopSession clears them, then AWAIT the cgroup
  // stops and the DB clear (stopSession's are fire-and-forget, which shutdown
  // would exit before), so a graceful restart leaves no scopes running or recorded.
  const scopes = sessionIds
    .map((id) => sessions.get(id)?.sessionScope)
    .filter((s): s is string => Boolean(s));
  for (const id of sessionIds) {
    stopSession(id);
  }
  await Promise.allSettled(scopes.map((scope) => stopSessionScope(scope)));
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
 * Reap systemd scopes orphaned by a previous crash. Runs once at startup, before
 * any session revives. Reaps EXACTLY the unit names recorded on session rows —
 * never a `clawed-*` glob, which would kill a co-tenant instance's live sessions
 * (see src/server/services/CLAUDE.md) — and clears only those names.
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

  // Clear exactly the names just reaped, not a blanket `sessionScope != null`: if a
  // session recorded a fresh live scope between the findMany and here, a blanket
  // clear would null a name still in use and leak that scope on the next crash.
  // Safe today given "runs once before any revive"; robust if that ever weakens.
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
