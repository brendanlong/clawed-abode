/**
 * Orchestrates one long-lived streaming Claude SDK `query()` per session: lazy
 * establishment with resume, the output loop that persists messages and derives
 * live status, sends, interrupts and teardown. Design and rationale live in
 * doc/claude-sessions.md; invariants in src/server/services/CLAUDE.md.
 */

import { access } from 'fs/promises';
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
import { processSingleton } from '@/lib/process-singleton';
import {
  classifyMessage,
  initSessionId,
  isEchoOfPushedPrompt,
  parseCommandLifecycle,
  type RetryState,
} from '@/lib/claude-messages';
import {
  diffLiveView,
  hasRealTurn,
  isRunning,
  liveView,
  reduceLiveTurn,
  type InFlightCommand,
  type LiveEvent,
  type LiveOutcome,
} from '@/lib/live-turn';
import { parseRateLimitEvent } from '@/lib/rate-limit';
import { backgroundActive, type BackgroundTask } from '@/lib/session-status';
import { createPushable } from '@/lib/pushable';
import type { ToolResponse } from '@/lib/tool-response';
import type { CancelledPrompt } from '@/lib/cancelled-prompt';
import { extractRepoFullName } from '@/lib/utils';
import { isDefaultSessionName } from '@/lib/session-name';
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
import { createSessionState, type LiveQuery, type SessionState } from './session-state';
import {
  createErrorMessage,
  bumpSessionActivity,
  insertMessage,
  insertPreparedMessage,
  prepareUserMessage,
  removeMessages,
} from './message-store';
import { cancelUnstartedCommands, discardUnreadPrompts } from './in-flight-commands';
import { emitQueuedPrompts, enqueuePrompts, type PromptPayload } from './prompt-queue';
import { recordRateLimitReadings, resolveSessionHold } from './rate-limit-state';
import { currentHold, withdrawQueuedWork, type PauseRunner } from './rate-limit-pause';
import {
  applyCommandMessage,
  forgetSessionCommands,
  replaceSessionCommands,
} from './session-commands';
import { resolveAgentName } from './agent-name';
import { buildLiveMcpServersRecord, buildSdkOptions } from './sdk-options';
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
const sessions = processSingleton('claude-runner.sessions', () => new Map<string, SessionState>());
/** Set by stopAllSessions so a revive racing shutdown doesn't start a new CLI. */
const shutdown = processSingleton('claude-runner.shutdown', () => ({ started: false }));

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
 * The only way live turn state changes: fold the event, then emit exactly the SSE
 * channels whose client-visible projection moved (plus "Claude finished"). Since
 * nothing else touches `state.turn`, the previous view is what clients last saw.
 */
function dispatch(sessionId: string, state: SessionState, event: LiveEvent): LiveOutcome {
  const before = liveView(state.turn);
  const outcome = reduceLiveTurn(state.turn, event);
  state.turn = outcome.state;

  const changes = diffLiveView(before, liveView(state.turn));
  if (changes.pendingMessageIds) {
    sseEvents.emitPendingMessages(sessionId, changes.pendingMessageIds);
  }
  if (changes.running !== undefined) sseEvents.emitClaudeRunning(sessionId, changes.running);
  if (outcome.finished) sseEvents.emitClaudeFinished(sessionId);
  if (changes.backgroundTasks) sseEvents.emitBackgroundTasks(sessionId, changes.backgroundTasks);
  if (changes.retry !== undefined) sseEvents.emitClaudeRetry(sessionId, changes.retry);
  return outcome;
}

/**
 * Detach a session's dead (or closing) query: reject its parked interactive tool
 * call and stop its systemd scope, reaping anything the CLI left running. Call
 * after dispatching `torn_down`. Resolves once the scope's processes are dead.
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
      // Delivery bookkeeping only: never persisted, and kept out of the stream
      // status (a top-level message would otherwise clear a retry indicator).
      const lifecycle = parseCommandLifecycle(message);
      if (lifecycle) {
        dispatch(sessionId, state, { type: 'command_lifecycle', lifecycle });
        continue;
      }

      if (isEchoOfPushedPrompt(message, live.pushedUuids)) continue;

      // Every other message, including ones skipped for persistence, since
      // `api_retry`/`task_*` drive status.
      if (dispatch(sessionId, state, { type: 'sdk_message', message }).turnEnded) {
        void detectBranchAndPr(sessionId, live.workingDir);
      }

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
    dispatch(sessionId, state, { type: 'torn_down' });
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
    select: {
      status: true,
      name: true,
      repoUrl: true,
      branch: true,
      createdBySessionId: true,
      repoPath: true,
      claudeModel: true,
      claudeSessionId: true,
    },
  });
  if (!session) {
    throw new Error('Session not found');
  }
  // Stop and Delete tear down memory before writing the status, so an
  // establishment that started just before them can still see it here.
  if (session.status !== 'running') {
    throw new Error(`Session is ${session.status}`);
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
  const { options, sessionScope, builtinMcpServer } = await buildSdkOptions({
    sessionId,
    // Best-effort: without it the CLI derives its own (unstable) name.
    agentName: await resolveAgentName(sessionId).catch((err) => {
      log.warn('Agent name unavailable', { sessionId, error: toError(err).message });
      return null;
    }),
    sessionNameIsDefault: isDefaultSessionName(session),
    createdBySessionId: session.createdBySessionId,
    workingDir,
    settings,
    resumeId,
    waitForUserInput: (request) =>
      new Promise<PermissionResult>((resolve, reject) => {
        if (!live || state.live !== live) {
          return reject(new Error('Session query is not available'));
        }
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
    // Exactly our name: a revive may already have recorded its own.
    if (sessionScope) void clearRecordedScopes([sessionScope]);
    throw new Error('Session establishment cancelled: session was stopped during establish');
  }

  const input = createPushable<SDKUserMessage>();
  const established: LiveQuery = {
    query: queryFactory({ prompt: input.iterable, options }),
    input,
    sessionScope,
    workingDir,
    boundSettings: settings,
    builtinMcpServer,
    settingsKey,
    claudeSessionId: null,
    pendingInput: null,
    toolSanitizations,
    pushedUuids: new Set(),
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
 * Ensure a live streaming query exists for a session, establishing one (with
 * `resume`) if needed. Idempotent and coalesced: concurrent callers share a
 * single establishment.
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
      await live.query.setMcpServers(
        buildLiveMcpServersRecord(settings.mcpServers, live.builtinMcpServer)
      );
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
 * `command_lifecycle`; until then it is in flight, marked undelivered in the
 * transcript and cancellable by Stop.
 */
function pushPreparedPrompt(sessionId: string, state: SessionState, prompt: PromptPayload): void {
  const live = state.live;
  if (!live) throw new Error('Session query is not available');

  const commandUuid = uuid();
  live.pushedUuids.add(commandUuid);
  dispatch(sessionId, state, {
    type: 'pushed',
    commandUuid,
    prompt: {
      messageId: prompt.messageId,
      text: prompt.text,
      attachments: prompt.attachments,
      content: prompt.content,
    },
  });

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
  const queuedBehind = hold ?? currentHold(sessionId);
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

/** The runner as the rate-limit pause sees it; handed over at startup. */
export const rateLimitPauseRunner: PauseRunner = {
  revive: (sessionId) => reviveSession(sessionId),
  turnActiveSessionIds: () =>
    new Set([...sessions].filter(([, state]) => hasRealTurn(state.turn)).map(([id]) => id)),

  async abortTurn(sessionId, steps) {
    const state = sessions.get(sessionId);
    if (!state?.live) return null;
    const result = await abortTurn(sessionId, state, state.live, {
      requireRealTurn: true,
      ...steps,
    });
    return { ...result, interruptPending: state.turn.interruptRequested };
  },

  sendUserMessage: (sessionId, prompt, opts) => sendUserMessage(sessionId, prompt, [], opts),

  async openQuery(sessionId) {
    const state = await ensureSessionQuery(sessionId);
    const live = state.live;
    return {
      isLive: () => live !== null && state.live === live,
      push: (prompt) => pushPreparedPrompt(sessionId, state, prompt),
    };
  },
};

/** Transcript ids of a session's not-yet-delivered messages (seeds the client). */
export function getPendingMessageIds(sessionId: string): string[] {
  const state = sessions.get(sessionId);
  return state ? liveView(state.turn).pendingMessageIds : [];
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
  return sessions.get(sessionId)?.turn.status.retry ?? null;
}

/** Current running background tasks for a session. In-memory only. */
export function getSessionBackgroundTasks(sessionId: string): BackgroundTask[] {
  const state = sessions.get(sessionId);
  return state ? [...state.turn.status.backgroundTasks.values()] : [];
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
  const recalledFromQueue = await withdrawQueuedWork(sessionId);

  const state = sessions.get(sessionId);
  if (!state?.live || !isRunning(state.turn)) {
    log.info('interruptClaude: nothing to interrupt', { sessionId });
    return { interrupted: false, cancelled: recalledFromQueue };
  }

  const { disposed, interrupted } = await abortTurn(sessionId, state, state.live, {
    requireRealTurn: false,
    dispose: (recalled) => discardUnreadPrompts(sessionId, recalled),
  });
  return { interrupted, cancelled: [...disposed, ...recalledFromQueue] };
}

/**
 * Recall everything the agent hasn't read, hand it to `dispose` (the caller's
 * policy: Stop deletes the bubbles, a pause re-queues them), then interrupt the
 * turn. The recall must come first: `interrupt()` wakes the CLI's drain loop,
 * which runs anything still queued as its own turn the instant the abort lands —
 * cancelling afterwards loses that race every time (doc/claude-sessions.md, "Stop
 * cancels what the agent hasn't read"). Disposal comes before the interrupt too, so
 * recalled prompts are never only in memory while it is awaited.
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
async function abortTurn<T>(
  sessionId: string,
  state: SessionState,
  live: LiveQuery,
  {
    requireRealTurn,
    dispose,
    beforeInterrupt,
  }: {
    requireRealTurn: boolean;
    dispose: (recalled: InFlightCommand[]) => Promise<T>;
    /** Runs once it is decided to interrupt, before the interrupt is sent. */
    beforeInterrupt?: () => Promise<void>;
  }
): Promise<{ disposed: T; interrupted: boolean }> {
  if (!requireRealTurn) dispatch(sessionId, state, { type: 'interrupt_requested' });

  const dropped = await cancelUnstartedCommands(
    sessionId,
    state.turn.inFlight,
    live.query,
    (commandUuid) => dispatch(sessionId, state, { type: 'recalled', commandUuids: [commandUuid] })
  );
  const disposed = await dispose(dropped);

  // Read after the awaits: recalling the push behind an optimistic turnActive ends
  // it, and an earlier interrupt may have landed meanwhile.
  const realTurn = hasRealTurn(state.turn);
  const abort =
    state.live === live &&
    (requireRealTurn ? realTurn && !state.turn.interruptRequested : isRunning(state.turn));
  if (!abort) {
    // Withdraw Stop's claim: no interrupt-driven turn-end is coming to consume it.
    if (!requireRealTurn) dispatch(sessionId, state, { type: 'interrupt_failed' });
    return { disposed, interrupted: false };
  }

  dispatch(sessionId, state, { type: 'interrupt_requested' });
  try {
    await beforeInterrupt?.();
    await live.query.interrupt();
  } catch (err) {
    // No interrupt-driven turn-end is coming; clear the flag so it can't suppress
    // a later, natural turn-end's notification.
    dispatch(sessionId, state, { type: 'interrupt_failed' });
    log.warn('Failed to interrupt turn', { sessionId, error: toError(err).message });
    return { disposed, interrupted: false };
  }
  return { disposed, interrupted: realTurn };
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
  return state ? isRunning(state.turn) : false;
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
  return state ? backgroundActive(state.turn.status) : false;
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
  dispatch(sessionId, state, { type: 'torn_down' });
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

/**
 * Establish a running session's query without a prompt, so its CLI is up and
 * reachable by other sessions. Skips a session the rate-limit pause holds (the
 * pause revives it on release) or whose workspace is gone (the CLI would only
 * fail into its transcript). Best-effort.
 */
export async function reviveSession(sessionId: string): Promise<void> {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { status: true, repoPath: true },
    });
    if (session?.status !== 'running' || currentHold(sessionId) || shutdown.started) return;
    const workingDir = getSessionWorkingDir(sessionId, session.repoPath);
    if (!(await pathExists(workingDir))) {
      log.warn('Not reviving session with no workspace', { sessionId, workingDir });
      return;
    }
    await ensureSessionQuery(sessionId);
  } catch (err) {
    log.warn('Failed to revive session', { sessionId, error: toError(err).message });
  }
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

/** Revive every running session, concurrently so one slow establishment can't hold up the rest. */
export async function reviveRunningSessions(): Promise<void> {
  const running = await prisma.session.findMany({
    where: { status: 'running' },
    select: { id: true },
  });
  log.info('Reviving running sessions', { count: running.length });
  await Promise.all(running.map(({ id }) => reviveSession(id)));
}

/** Stop all active Claude queries (graceful shutdown). */
export async function stopAllSessions(): Promise<void> {
  shutdown.started = true;
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
