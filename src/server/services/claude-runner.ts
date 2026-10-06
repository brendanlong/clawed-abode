/**
 * Orchestrates one long-lived streaming Claude SDK `query()` per session: lazy
 * establishment with resume, the output loop that persists messages and derives
 * live status, sends, interrupts and teardown. Design and rationale live in
 * doc/claude-sessions.md; invariants in src/server/services/CLAUDE.md.
 */

import {
  query as sdkQuery,
  type Query,
  type Options,
  type PermissionResult,
  type SDKUserMessage,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID as uuid } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { classifyMessage, initSessionId, type RetryState } from '@/lib/claude-messages';
import { holdsEqual, parseRateLimitEvent, type RateLimitHold } from '@/lib/rate-limit';
import { reduceSessionMessage, backgroundActive, type BackgroundTask } from '@/lib/session-status';
import { createPushable } from '@/lib/pushable';
import type { ToolResponse } from '@/lib/tool-response';
import type { CancelledPrompt } from '@/lib/cancelled-prompt';
import { extractRepoFullName } from '@/lib/utils';
import { createLogger, toError } from '@/lib/logger';
import { attachToolResultSanitizations } from '@/lib/message-sanitization';
import { partialMessageId } from '@/lib/message-cache';
import { sseEvents } from './events';
import { getSessionWorkingDir } from './worktree-manager';
import {
  loadMergedSessionSettings,
  mcpServersEqual,
  type MergedSessionSettings,
} from './settings-merger';
import { StreamAccumulator } from './stream-accumulator';
import { stopSessionScope } from './session-cgroup';
import {
  createSessionState,
  type InFlightCommand,
  type LiveQuery,
  type SessionState,
} from './session-state';
import {
  createErrorMessage,
  bumpSessionActivity,
  insertMessage,
  insertPreparedMessage,
  prepareUserMessage,
  removeMessages,
} from './message-store';
import {
  discardUnreadPrompts,
  effectiveRunning,
  handleCommandLifecycle,
  isTopLevelMessageStart,
  pendingMessageIds,
  recallUnstartedCommands,
  retireInFlightCommands,
  syncRunning,
} from './in-flight-commands';
import {
  clearQueuedPrompts,
  emitQueuedPrompts,
  claimQueuedPrompt,
  enqueuePrompts,
  listQueuedPrompts,
  type QueuedPrompt,
} from './prompt-queue';
import {
  loadRateLimitReadings,
  recordRateLimitReadings,
  resolveAllSessionHolds,
  resolveSessionHold,
  setRateLimitChangeHandler,
} from './rate-limit-state';
import {
  applyCommandMessage,
  forgetSessionCommands,
  replaceSessionCommands,
} from './session-commands';
import { buildMcpServersRecord, buildSdkOptions } from './sdk-options';
import { cancelBranchPrRefresh, detectBranchAndPr } from './session-branch-pr';

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
 * Record the Claude Code conversation the CLI reports (it switches on `/clear`) so
 * the next revive resumes it rather than the pre-clear transcript. The in-memory
 * copy only advances after a successful write, so a failed write retries on the
 * next init. A torn-down loop never writes: a revive may already own the row.
 */
async function trackClaudeSessionId(
  sessionId: string,
  state: SessionState,
  live: LiveQuery,
  message: SDKMessage
): Promise<void> {
  const claudeSessionId = initSessionId(message);
  if (!claudeSessionId || claudeSessionId === live.claudeSessionId) return;
  if (state.live !== live) return;
  try {
    await prisma.session.updateMany({ where: { id: sessionId }, data: { claudeSessionId } });
    live.claudeSessionId = claudeSessionId;
  } catch (err) {
    log.error('Failed to persist Claude session id', toError(err), { sessionId, claudeSessionId });
  }
}

/**
 * Force all live status off and emit only the channels that changed. Used by the
 * loop `finally`, `stopSession`, and shutdown so a torn-down session never leaves
 * a stale "running"/"background"/"retrying" indicator.
 */
function clearLiveStatus(sessionId: string, state: SessionState): void {
  state.interruptRequested = false;
  state.optimisticTurnActive = false;
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
  // The SDK's background-task level is per CLI process and sends nothing at
  // startup, so the set must start empty for the next process.
  const hadBackgroundTasks = state.status.backgroundTasks.size > 0;
  state.status = { ...state.status, backgroundTasks: new Map(), subagentTypes: new Map() };
  if (hadBackgroundTasks) sseEvents.emitBackgroundTasks(sessionId, []);
  if (state.status.retry) {
    state.status = { ...state.status, retry: null };
    sseEvents.emitClaudeRetry(sessionId, null);
  }
}

/**
 * Detach a session's dead (or closing) query: reject its parked interactive tool
 * call and stop its systemd scope, reaping anything the CLI left running. Call
 * after {@link clearLiveStatus}. Resolves once the scope's processes are dead.
 */
function releaseQuery(sessionId: string, state: SessionState, reason: string): Promise<void> {
  const live = state.live;
  if (!live) return Promise.resolve();
  state.live = null;
  live.pendingInput?.reject(new Error(reason));
  live.pendingInput = null;
  if (!live.sessionScope) return Promise.resolve();
  const stopped = stopSessionScope(live.sessionScope);
  void persistSessionScope(sessionId, null);
  return stopped;
}

/**
 * Fold one message into the session's live status and emit changed channels.
 * Runs for EVERY message (including ones skipped for persistence, since
 * `api_retry`/`task_*` drive status). Fires the branch/PR refresh at a main-turn end.
 */
function applyStatus(
  sessionId: string,
  state: SessionState,
  live: LiveQuery,
  message: SDKMessage
): void {
  const { status, changed } = reduceSessionMessage(state.status, message);
  const turnEnded = changed.turnActive && !status.turnActive;

  // An interrupt's turn-end is not Claude finishing — the user stopped it.
  const interrupted = turnEnded && state.interruptRequested;
  if (turnEnded) state.interruptRequested = false;

  state.status = status;
  // Any real turn boundary supersedes the optimistic flag: from here on the
  // stream owns turnActive. `message_start` needs its own clause — it lands while
  // the flag already reads true, so it moves no axis for `changed` to report.
  if (changed.turnActive || isTopLevelMessageStart(message) || message.type === 'result') {
    state.optimisticTurnActive = false;
  }

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
    void detectBranchAndPr(sessionId, live.workingDir);
  }
}

/**
 * The long-lived output loop for a session's query. Persists complete messages,
 * emits partials, and folds every message into live status. Exits only when the
 * input channel closes, the query is closed, or the SDK throws.
 */
async function runSessionLoop(
  sessionId: string,
  state: SessionState,
  live: LiveQuery
): Promise<void> {
  const accumulator = new StreamAccumulator();
  let nextPartialSequence = 0;

  try {
    for await (const message of live.query) {
      // Delivery bookkeeping first: `command_lifecycle` can retire a pending
      // message, which feeds the running state applyStatus is about to emit.
      if (handleCommandLifecycle(sessionId, state, message)) continue;

      applyStatus(sessionId, state, live, message);

      // Account-wide rate-limit state arrives on whichever session's stream happens
      // to be talking to the API; recording it re-evaluates the pause for ALL
      // sessions (see recomputeRateLimitHolds).
      const readings = parseRateLimitEvent(message, Date.now());
      if (readings.length > 0) void recordRateLimitReadings(readings);

      if (message.type === 'stream_event') {
        const partial = accumulator.accumulate(message);
        if (partial) {
          sseEvents.emitNewMessage(sessionId, {
            id: partialMessageId(partial.parent_tool_use_id),
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
        accumulator.completeMessage(message.parent_tool_use_id);
      } else if (message.type === 'result') {
        accumulator.resetAll();
      }

      applyCommandMessage(sessionId, message);
      await trackClaudeSessionId(sessionId, state, live, message);

      const handling = classifyMessage(message);
      if (handling.kind !== 'persist') continue;

      // Attach sanitizer findings for this message's tool results so the UI can
      // badge the exact tool result whose hidden content was filtered. Findings are
      // removed only once the message is durably persisted, so a duplicate/no-op
      // insert can't consume a badge it never wrote.
      const attachedSanitizations =
        handling.dbType === 'user' && live.toolSanitizations.size > 0
          ? attachToolResultSanitizations(message, live.toolSanitizations)
          : [];

      const id = (message as { uuid?: string }).uuid || uuid();
      const { inserted, sequence } = await insertMessage({
        sessionId,
        id,
        type: handling.dbType,
        content: message,
      });
      if (inserted) {
        for (const toolUseId of attachedSanitizations) live.toolSanitizations.delete(toolUseId);
      }
      if (sequence !== undefined) nextPartialSequence = sequence + 1;
    }
    log.info('runSessionLoop: stream ended', { sessionId });
  } catch (err) {
    log.error('runSessionLoop: error', toError(err), { sessionId });
    await createErrorMessage(sessionId, `Claude query failed: ${toError(err).message}`);
  } finally {
    clearLiveStatus(sessionId, state);
    // Drop the live query so the next interaction re-establishes (resume). The
    // state record stays in the map (commands etc. persist); only stop/delete
    // remove it. The guard skips this when stopSession already released it.
    if (state.live === live) void releaseQuery(sessionId, state, 'Query ended');
  }
}

/**
 * Establish a fresh streaming query for a session: load settings, build the input
 * channel + options, start the SDK query and its output loop. Resumes the
 * conversation the CLI last announced, if any.
 */
async function establishSessionQuery(
  sessionId: string,
  state: SessionState
): Promise<SessionState> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { repoUrl: true, repoPath: true, claudeModel: true, claudeSessionId: true },
  });
  if (!session) {
    throw new Error('Session not found');
  }

  const repoFullName = session.repoUrl ? extractRepoFullName(session.repoUrl) : null;
  const settingsKey = repoFullName ?? '__no_repo__';
  const settings = await loadMergedSessionSettings(sessionId, settingsKey, session.claudeModel);
  const workingDir = getSessionWorkingDir(sessionId, session.repoPath);

  // Only a conversation the CLI announced has a transcript to resume; app-side
  // messages alone (a rate-limit-queued first prompt, an error from a query that
  // died before init) don't mean one was ever written.
  const resumeId = session.claudeSessionId;
  // The SDK only calls these once the query below exists, so `live` is set by then.
  let live: LiveQuery | null = null;
  const toolSanitizations: LiveQuery['toolSanitizations'] = new Map();
  const { options, sessionScope } = await buildSdkOptions({
    sessionId,
    workingDir,
    settings,
    resumeId,
    waitForUserInput: (request) =>
      new Promise<PermissionResult>((resolve, reject) => {
        if (!live) return reject(new Error('Session query is not available'));
        live.pendingInput?.reject(new Error('Superseded by another tool request'));
        live.pendingInput = { ...request, resolve, reject };
      }),
    recordSanitization: (toolUseId, info) => toolSanitizations.set(toolUseId, info),
  });
  // Record the scope name durably BEFORE the subprocess (and thus the scope) is
  // spawned, so a crash between here and teardown can always reap it by exact
  // name. Over-recording — a name written for a scope that ends up not created
  // because establish aborts below — is harmless: the reap's stop is a no-op.
  if (sessionScope) await persistSessionScope(sessionId, sessionScope);

  // If `stopSession` ran while we were loading (it deletes the map entry), abort
  // before creating the query — otherwise we'd resurrect a torn-down session with
  // an orphan live query. This check and the attach below are await-free, so they
  // run atomically with respect to a synchronous stopSession.
  if (sessions.get(sessionId) !== state) {
    throw new Error('Session establishment cancelled: session was stopped during establish');
  }

  const input = createPushable<SDKUserMessage>();
  const established: LiveQuery = {
    query: queryFactory({ prompt: input.iterable, options }),
    input,
    sessionScope,
    workingDir,
    boundSettings: settings,
    settingsKey,
    claudeSessionId: null,
    pendingInput: null,
    toolSanitizations,
  };
  live = established;
  state.live = established;

  log.info('Established session query', { sessionId, workingDir, resumeId });

  void established.query
    .supportedCommands()
    .then((commands) => {
      // A result landing after Stop/Delete would clobber a newer query's list or resurrect a forgotten one.
      if (sessions.get(sessionId)?.live === established)
        replaceSessionCommands(sessionId, commands);
    })
    .catch((err) => {
      log.debug('Failed to fetch supportedCommands', { sessionId, error: toError(err).message });
    });

  void runSessionLoop(sessionId, state, established);

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
  if (existing?.live) return Promise.resolve(existing);
  if (existing?.establishing) return existing.establishing;

  const state = existing ?? createSessionState();
  sessions.set(sessionId, state);
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
async function applyLiveSettings(sessionId: string, live: LiveQuery): Promise<void> {
  let settings: MergedSessionSettings;
  try {
    // Re-read the per-session model override too, so sessions.setModel applies live.
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { claudeModel: true },
    });
    settings = await loadMergedSessionSettings(sessionId, live.settingsKey, session?.claudeModel);
  } catch (err) {
    log.debug('applyLiveSettings: failed to load settings', {
      sessionId,
      error: toError(err).message,
    });
    return;
  }

  const bound = live.boundSettings;
  try {
    if (settings.claudeModel !== bound.claudeModel) {
      await live.query.setModel(settings.claudeModel);
      log.info('Applied live model change', { sessionId, model: settings.claudeModel });
    }
    if (!mcpServersEqual(bound.mcpServers, settings.mcpServers)) {
      await live.query.setMcpServers(buildMcpServersRecord(settings.mcpServers) ?? {});
      log.info('Applied live MCP server change', { sessionId });
    }
    live.boundSettings = settings;
  } catch (err) {
    log.warn('applyLiveSettings: failed to apply', { sessionId, error: toError(err).message });
  }
}

/**
 * Push a prepared prompt into a live query and start tracking its delivery. The
 * push is stamped with a `uuid` so the CLI reports progress over
 * `command_lifecycle`; until then it sits in `inFlightCommands`, marked
 * undelivered in the transcript and cancellable by Stop.
 */
function pushPreparedPrompt(
  sessionId: string,
  state: SessionState,
  prompt: Omit<QueuedPrompt, 'id' | 'position'>
): void {
  const live = state.live;
  if (!live) throw new Error('Session query is not available');

  const commandUuid = uuid();
  state.inFlightCommands.set(commandUuid, {
    messageId: prompt.messageId,
    text: prompt.text,
    attachments: prompt.attachments,
    content: prompt.content,
    started: false,
    resultsSeen: 0,
  });
  sseEvents.emitPendingMessages(sessionId, pendingMessageIds(state));
  // Optimistically mark the turn active so the reducer's true→false edge — and
  // the work-complete signal — stays intact for a turn that reaches its terminal
  // `result` without a `message_start`.
  if (!state.status.turnActive) {
    state.status = { ...state.status, turnActive: true };
    state.optimisticTurnActive = true;
  }
  syncRunning(sessionId, state);

  live.input.push({
    type: 'user',
    message: { role: 'user', content: prompt.content },
    parent_tool_use_id: null,
    uuid: commandUuid as SDKUserMessage['uuid'],
  });
}

/**
 * Send a user prompt: persisted and pushed into the streaming query immediately,
 * whatever the agent is doing (the CLI folds a mid-turn message into the running
 * turn).
 *
 * The one exception is a session paused for a subscription rate limit: the bubble
 * is still written (the user sees what they sent) but the prompt goes to the
 * durable queue instead of the SDK, and no query is established — see
 * doc/rate-limit-pause.md.
 *
 * `attachments` are stored names (see /api/upload), resolved to paths here.
 */
export async function sendUserMessage(
  sessionId: string,
  prompt: string,
  attachments: string[] = [],
  { userInitiated = true } = {}
): Promise<void> {
  const hold = await resolveSessionHold(sessionId);
  const state = hold ? null : await ensureSessionQuery(sessionId);
  if (state) {
    if (!state.live) throw new Error('Session query is not available');
    await applyLiveSettings(sessionId, state.live);
  }
  if (userInitiated) await bumpSessionActivity(sessionId);

  // Sanitize/resolve up front (no side effects) so a failure aborts cleanly before
  // anything is persisted and the client keeps the just-typed text to retry.
  const prepared = await prepareUserMessage(sessionId, prompt, attachments);

  const messageId = uuid();
  await insertPreparedMessage(sessionId, messageId, prepared);

  const pushable = { messageId, content: prepared.content, text: prompt, attachments };

  // A hold can land during the awaits above, after the check at the top. Re-read
  // it here — synchronously, from the last recompute — because this is the same
  // statement as the push: a prompt decided against a stale answer would go
  // straight into a window the API is refusing, which is the one thing the pause
  // exists to prevent.
  const queuedBehind = hold ?? emittedHolds.get(sessionId);
  if (!state || queuedBehind) {
    await enqueuePrompts(sessionId, [pushable]);
    await emitQueuedPrompts(sessionId);
    log.info('Queued prompt behind rate-limit pause', { sessionId, hold: queuedBehind });
    return;
  }

  // Re-check the query *after* the insert: the query loop can exit mid-await (CLI
  // crash, stop) and release it. Tracking a command we never pushed would strand it
  // in-flight forever, so undo the bubble and surface the failure instead.
  if (!state.live) {
    await removeMessages(sessionId, [messageId]);
    throw new Error('Session query is not available');
  }

  pushPreparedPrompt(sessionId, state, pushable);
}

/**
 * Prompt sent to a session whose turn a rate-limit pause cut short, once the
 * window resets. Phrased so an agent that had already finished can say so
 * cheaply rather than redoing work.
 */
export const RATE_LIMIT_RESUME_PROMPT =
  'The subscription usage window has reset. Continue the work you were doing when the ' +
  'usage limit paused you. If you had already finished, just say so briefly.';

/** Last hold emitted per session, so only real transitions hit the SSE channel. */
const emittedHolds = new Map<string, RateLimitHold>();

/**
 * Serializes {@link recomputeRateLimitHolds}. Readings arrive from several
 * sessions at once, and two concurrent recomputes would race to push the same
 * queued prompt twice. A recompute requested while one is running is coalesced
 * into a single follow-up run, so the last state always wins.
 */
let recomputeInFlight: Promise<void> | null = null;
let recomputeRequested = false;

/**
 * Re-evaluate every session's rate-limit hold and act on it: pause the newly held
 * (recall what the CLI hasn't read into the durable queue) and drain the newly
 * released. Idempotent — it computes the desired state and converges on it rather
 * than tracking edges, so a missed or duplicated trigger is harmless.
 */
export function recomputeRateLimitHolds(): Promise<void> {
  if (recomputeInFlight) {
    recomputeRequested = true;
    return recomputeInFlight;
  }
  // The trigger is a fire-and-forget callback from rate-limit-state, so nothing
  // is left to catch a rejection: swallow it here rather than crash the process.
  recomputeInFlight = runRecompute()
    .catch((err: unknown) => log.error('Rate-limit recompute failed', toError(err)))
    .finally(() => {
      recomputeInFlight = null;
      if (recomputeRequested) {
        recomputeRequested = false;
        void recomputeRateLimitHolds();
      }
    });
  return recomputeInFlight;
}

async function runRecompute(): Promise<void> {
  // Snapshot which sessions are genuinely mid-turn BEFORE any await: a rejection
  // kills the turn it lands in, and by the time the holds are resolved that turn
  // may already have collapsed — losing the very fact that tells us to nudge it
  // later. A merely optimistic turnActive doesn't count: nothing started, so
  // there is nothing to continue, and the prompt is recalled into the queue where
  // it will run again in full.
  const turnActiveSessionIds = new Set(
    [...sessions]
      .filter(([, state]) => state.status.turnActive && !state.optimisticTurnActive)
      .map(([id]) => id)
  );

  let holds: Map<string, RateLimitHold>;
  try {
    holds = await resolveAllSessionHolds();
  } catch (err) {
    log.error('Failed to resolve rate-limit holds', toError(err));
    return;
  }

  for (const sessionId of new Set([...holds.keys(), ...emittedHolds.keys()])) {
    const next = holds.get(sessionId) ?? null;
    if (holdsEqual(emittedHolds.get(sessionId) ?? null, next)) continue;
    if (next) emittedHolds.set(sessionId, next);
    else emittedHolds.delete(sessionId);
    sseEvents.emitRateLimitHold(sessionId, next);
  }

  for (const [sessionId, hold] of holds) {
    try {
      await pauseSessionForRateLimit(sessionId, hold, turnActiveSessionIds.has(sessionId));
    } catch (err) {
      // One session failing to park must not skip the drain phase for the rest.
      log.error('Failed to pause session for rate limit', toError(err), { sessionId });
    }
  }

  let toDrain: { id: string }[];
  try {
    toDrain = await prisma.session.findMany({
      where: {
        status: 'running',
        OR: [{ resumeAfterRateLimit: true }, { queuedPrompts: { some: {} } }],
      },
      select: { id: true },
    });
  } catch (err) {
    log.error('Failed to list sessions with queued work', toError(err));
    return;
  }

  for (const { id } of toDrain) {
    if (holds.has(id)) continue;
    await drainSessionAfterRateLimit(id);
  }
}

/**
 * Hold a session's work: pull back everything the CLI has queued but not read into
 * the durable queue, then interrupt the live turn so it stops spending — a long
 * turn (subagents especially) can otherwise run on for hours past the limit.
 */
async function pauseSessionForRateLimit(
  sessionId: string,
  hold: RateLimitHold,
  hadActiveTurn: boolean
): Promise<void> {
  const state = sessions.get(sessionId);
  const live = state?.live;
  let interrupted = false;
  if (state && live) {
    const aborted = await abortTurn(sessionId, state, live, { requireRealTurn: true });
    const { recalled } = aborted;
    interrupted = aborted.interrupted;
    if (recalled.length > 0) {
      await enqueuePrompts(
        sessionId,
        recalled.map((command) => ({
          messageId: command.messageId,
          content: command.content,
          text: command.text,
          attachments: command.attachments,
        }))
      );
      await emitQueuedPrompts(sessionId);
    }
    if (recalled.length > 0 || interrupted) {
      log.info('Paused session for rate limit', {
        sessionId,
        limitType: hold.limitType,
        reason: hold.reason,
        requeued: recalled.length,
        interrupted,
        resumesAt: new Date(hold.untilMs).toISOString(),
      });
    }
  }

  // A rejection may already have killed the turn before we got here, so it goes
  // by the pre-await snapshot (unless an interrupt is already underway); otherwise
  // only a turn we actually cut short needs a nudge once the window resets.
  const rejectedMidTurn = hold.reason === 'rejected' && hadActiveTurn && !state?.interruptRequested;
  if (interrupted || rejectedMidTurn) {
    try {
      await prisma.session.updateMany({
        where: { id: sessionId },
        data: { resumeAfterRateLimit: true },
      });
    } catch (err) {
      log.warn('Failed to flag session for post-rate-limit resume', {
        sessionId,
        error: toError(err).message,
      });
    }
  }
}

/**
 * Release a session: nudge it to continue a turn the limit cut short, then re-push
 * its queued prompts in order. Each push re-reads the input channel, so a query
 * that dies mid-drain simply leaves the rest queued for the next attempt rather
 * than dropping it.
 */
async function drainSessionAfterRateLimit(sessionId: string): Promise<void> {
  try {
    const { count } = await prisma.session.updateMany({
      where: { id: sessionId, status: 'running', resumeAfterRateLimit: true },
      data: { resumeAfterRateLimit: false },
    });
    if (count > 0) {
      log.info('Resuming turn cut short by a rate limit', { sessionId });
      // Not user-initiated: a window resetting is a lifecycle event, and bumping
      // lastActivityAt would reshuffle the session list with no user involved
      // (see doc/DESIGN.md on Session.lastActivityAt).
      await sendUserMessage(sessionId, RATE_LIMIT_RESUME_PROMPT, [], { userInitiated: false });
    }

    const queued = await listQueuedPrompts(sessionId);
    if (queued.length === 0) return;

    log.info('Releasing prompts queued behind a rate-limit pause', {
      sessionId,
      count: queued.length,
    });
    const state = await ensureSessionQuery(sessionId);
    for (const prompt of queued) {
      // The input can vanish mid-drain (CLI crash, stop); leave the rest queued.
      if (!state.live) break;
      // Claim before pushing: Stop can empty the queue underneath this loop, and
      // pushing a prompt it already took back would run cancelled work with no
      // bubble to show for it.
      if (!(await claimQueuedPrompt(prompt.id))) continue;
      pushPreparedPrompt(sessionId, state, prompt);
    }
  } catch (err) {
    // Leaving the queue in place is the safe failure: the next recompute retries.
    log.error('Failed to drain rate-limit queue', toError(err), { sessionId });
  } finally {
    await emitQueuedPrompts(sessionId).catch(() => {});
  }
}

/**
 * Wire up the rate-limit pause and restore its state, then kick a first recompute.
 *
 * Restoring the readings is awaited so nothing can release queued work before we
 * know whether the window is still exhausted. The recompute is deliberately NOT
 * awaited: if the window reset while the server was down it drains, which means
 * establishing queries — and a slow one must not stall startup. That drain is the
 * one place a session revives without a user interaction (doc/DESIGN.md's lazy
 * revival); the user's queued prompt is exactly the interaction, just an earlier one.
 */
export async function initRateLimitPause(): Promise<void> {
  setRateLimitChangeHandler(() => void recomputeRateLimitHolds());
  await loadRateLimitReadings();
  void recomputeRateLimitHolds();
}

/**
 * Whether a session is currently paused for a rate limit, from the last
 * recompute's in-memory result — cheap enough for the session list, which reads it
 * per row.
 */
export function isSessionRateLimitPaused(sessionId: string): boolean {
  return emittedHolds.has(sessionId);
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
    const live = sessions.get(sessionId)?.live;
    const pending = live?.pendingInput;

    if (live && pending && pending.toolUseId === toolUseId) {
      live.pendingInput = null;
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
    if (!live || Date.now() >= deadline) {
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
 * hasn't read yet — including prompts parked behind a rate-limit pause, which is
 * the only way to take those back (a paused session has no live turn, so Stop
 * would otherwise have nothing to act on). The query stays alive; the SDK emits a
 * terminal `result` which the loop maps to `turnActive = false`. If that never
 * came, the header Stop (closing the query) is the deterministic escape — never a
 * timer.
 */
export async function interruptClaude(sessionId: string): Promise<InterruptResult> {
  const recalledFromQueue = await discardQueuedPrompts(sessionId);

  const state = sessions.get(sessionId);
  if (!state?.live || !effectiveRunning(state)) {
    log.info('interruptClaude: nothing to interrupt', { sessionId });
    return { interrupted: false, cancelled: recalledFromQueue };
  }

  const { recalled, interrupted } = await abortTurn(sessionId, state, state.live, {
    requireRealTurn: false,
  });
  const cancelled = await discardUnreadPrompts(sessionId, recalled);
  return { interrupted, cancelled: [...cancelled, ...recalledFromQueue] };
}

/**
 * Recall everything the agent hasn't read, then interrupt the turn. The recall
 * must come first: `interrupt()` wakes the CLI's drain loop, which runs anything
 * still queued as its own turn the instant the abort lands — cancelling afterwards
 * loses that race every time (doc/claude-sessions.md, "Stop cancels what the agent
 * hasn't read"). What happens to the recalled prompts is the caller's policy.
 *
 * `requireRealTurn` selects the rate-limit pause's policy: interrupt only a turn
 * the stream actually opened (an optimistic one has nothing started to cut short)
 * and leave one already being interrupted alone — whoever asked owns its resume
 * flag, and a user's Stop must not have it set back. Stop instead interrupts
 * whatever is still running, and claims the coming turn-end as an interrupt before
 * the recall, so a turn that ends naturally meanwhile can't fire "Claude finished"
 * for work the user just cancelled.
 *
 * `interrupted` is true only when a turn the stream had opened was aborted, so the
 * caller never stamps "Interrupted" on a turn that had already finished.
 */
async function abortTurn(
  sessionId: string,
  state: SessionState,
  live: LiveQuery,
  { requireRealTurn }: { requireRealTurn: boolean }
): Promise<{ recalled: InFlightCommand[]; interrupted: boolean }> {
  const alreadyInterrupting = requireRealTurn && state.interruptRequested;
  if (!requireRealTurn) state.interruptRequested = state.status.turnActive;

  const recalled = await recallUnstartedCommands(sessionId, state, live.query);

  // Read after the recall: recalling the push behind an optimistic turnActive ends it.
  const realTurn = state.status.turnActive && !state.optimisticTurnActive;
  const abort =
    state.live === live &&
    !alreadyInterrupting &&
    (requireRealTurn ? realTurn : effectiveRunning(state));
  if (!abort) {
    // Withdraw Stop's claim: no interrupt-driven turn-end is coming to consume it.
    if (!requireRealTurn) state.interruptRequested = false;
    return { recalled, interrupted: false };
  }

  state.interruptRequested = state.status.turnActive;
  try {
    await live.query.interrupt();
  } catch (err) {
    // No interrupt-driven turn-end is coming; clear the flag so it can't suppress
    // a later, natural turn-end's notification.
    state.interruptRequested = false;
    log.warn('Failed to interrupt turn', { sessionId, error: toError(err).message });
    return { recalled, interrupted: false };
  }
  return { recalled, interrupted: realTurn };
}

/**
 * Empty a session's rate-limit queue for Stop: the prompts never ran, so their
 * bubbles go too and the text comes back for the composer. Also cancels a pending
 * "continue where you left off" nudge — the user stopping is a clear signal they
 * don't want the session picking work back up on its own.
 */
async function discardQueuedPrompts(sessionId: string): Promise<CancelledPrompt[]> {
  const queued = await clearQueuedPrompts(sessionId);
  await prisma.session.updateMany({
    where: { id: sessionId, resumeAfterRateLimit: true },
    data: { resumeAfterRateLimit: false },
  });
  if (queued.length === 0) return [];

  const cancelled = await discardUnreadPrompts(sessionId, queued);
  await emitQueuedPrompts(sessionId);
  return cancelled;
}

/**
 * Stop a background task via the SDK. The indicator clears when the SDK's next
 * `background_tasks_changed` drops the task. `false` when there is no live query
 * or the SDK rejected the stop.
 */
export async function stopBackgroundTask(sessionId: string, taskId: string): Promise<boolean> {
  const query = sessions.get(sessionId)?.live?.query;
  if (!query) return false;
  try {
    await query.stopTask(taskId);
    return true;
  } catch (err) {
    log.warn('stopBackgroundTask: stopTask failed', {
      sessionId,
      taskId,
      error: toError(err).message,
    });
    return false;
  }
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
  const live = sessions.get(sessionId)?.live;
  if (live) await applyLiveSettings(sessionId, live);
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
 * active map (no lazy revive until the next explicit interaction). The in-memory
 * teardown is synchronous; the returned promise resolves once the session's
 * scope (and every process in it) is gone.
 */
export function stopSession(sessionId: string): Promise<void> {
  const state = sessions.get(sessionId);
  if (!state) return Promise.resolve();

  state.live?.input.close();
  try {
    state.live?.query.close();
  } catch {
    // ignore close errors
  }
  clearLiveStatus(sessionId, state);
  // Closing the query kills the launcher, but stopping the scope is what
  // cgroup-kills the whole tree (incl. daemons the agent backgrounded).
  const stopped = releaseQuery(sessionId, state, 'Session stopped');
  sessions.delete(sessionId);
  return stopped;
}

/**
 * Clean up all in-memory state for a session, including its slash commands
 * (archive/delete). Resolves once its processes are dead, so the caller can
 * remove the workspace without a daemon recreating files behind it.
 */
export async function cleanupSession(sessionId: string): Promise<void> {
  const stopped = stopSession(sessionId);
  forgetSessionCommands(sessionId);
  cancelBranchPrRefresh(sessionId);
  await stopped;
}

/** Stop all active Claude queries (graceful shutdown). */
export async function stopAllSessions(): Promise<void> {
  const sessionIds = [...sessions.keys()];
  if (sessionIds.length === 0) return;

  log.info('Stopping all active sessions for shutdown', { count: sessionIds.length });
  // Capture scope names before stopSession clears them so the DB clear can be
  // awaited too (stopSession's is fire-and-forget, which shutdown would exit
  // before): a graceful restart leaves no scopes running or recorded.
  const scopes = sessionIds
    .map((id) => sessions.get(id)?.live?.sessionScope)
    .filter((s): s is string => Boolean(s));
  await Promise.allSettled(sessionIds.map((id) => stopSession(id)));
  if (scopes.length > 0) await clearRecordedScopes(scopes);
}

/** Null out exactly these recorded scope names. Best-effort, like persistSessionScope. */
async function clearRecordedScopes(scopes: string[]): Promise<void> {
  try {
    await prisma.session.updateMany({
      where: { sessionScope: { in: scopes } },
      data: { sessionScope: null },
    });
  } catch (err) {
    log.debug('Failed to clear recorded session scopes', { error: toError(err).message });
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
  await Promise.allSettled(scopes.map((scope) => stopSessionScope(scope)));

  // Clear exactly the names just reaped, not a blanket `sessionScope != null`: if a
  // session recorded a fresh live scope between the findMany and here, a blanket
  // clear would null a name still in use and leak that scope on the next crash.
  // Safe today given "runs once before any revive"; robust if that ever weakens.
  await clearRecordedScopes(scopes);
}
