import { basename } from 'path';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseCommandLifecycle } from '@/lib/claude-messages';
import { displayFileName, type UploadedAttachment } from '@/lib/attachments';
import type { CancelledPrompt } from '@/lib/cancelled-prompt';
import { createLogger, toError } from '@/lib/logger';
import { sseEvents } from './events';
import { removeMessages } from './message-store';
import { resolveUploadPaths } from './uploads';
import type { InFlightCommand, SessionState } from './session-state';

const log = createLogger('in-flight-commands');

/**
 * Delivery tracking for user messages pushed into the SDK but not yet visibly
 * worked on — see {@link InFlightCommand} for the two stages. Rationale for the
 * design (why `claude_running` includes undelivered messages, why retirement is
 * never time-based, why Stop cancels before interrupting) is in
 * doc/claude-sessions.md under "Sends Are Immediate".
 */

/** What the composer shows as "Claude is working": a live turn, or an undelivered push. */
export function effectiveRunning(state: SessionState): boolean {
  return state.status.turnActive || state.inFlightCommands.size > 0;
}

/**
 * Emit `claude_running` if the effective value changed since the last emit. Called
 * after anything that can move either input (a status fold, a push, a delivery).
 */
export function syncRunning(sessionId: string, state: SessionState): boolean {
  const running = effectiveRunning(state);
  if (running === state.emittedRunning) return false;
  state.emittedRunning = running;
  sseEvents.emitClaudeRunning(sessionId, running);
  return true;
}

/**
 * Transcript ids of the messages the agent hasn't read yet, in push order — the
 * ones the client marks "Sending…".
 */
export function pendingMessageIds(state: SessionState): string[] {
  return [...state.inFlightCommands.values()].filter((c) => !c.started).map((c) => c.messageId);
}

/**
 * Fold a `command_lifecycle` message into the in-flight set. Returns true if the
 * message was a lifecycle event (and so must not be persisted).
 *
 * `queued` is the CLI acknowledging receipt. `started` clears the "Sending…" marker
 * but the entry lives on until the turn it feeds opens; a terminal
 * `completed`/`cancelled` retires it outright, covering a `started` that never arrived.
 */
export function handleCommandLifecycle(
  sessionId: string,
  state: SessionState,
  message: unknown
): boolean {
  const lifecycle = parseCommandLifecycle(message);
  if (!lifecycle) return false;
  state.commandLifecycleSeen = true;
  if (lifecycle.state === 'queued') return true;

  const command = state.inFlightCommands.get(lifecycle.command_uuid);
  if (!command) return true;
  if (lifecycle.state === 'started') {
    if (command.started) return true;
    command.started = true;
  } else {
    state.inFlightCommands.delete(lifecycle.command_uuid);
  }
  sseEvents.emitPendingMessages(sessionId, pendingMessageIds(state));
  syncRunning(sessionId, state);
  return true;
}

/** Whether a message is the main agent's (top-level) `message_start`. */
export function isTopLevelMessageStart(message: SDKMessage): boolean {
  if (message.type !== 'stream_event') return false;
  const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  if (parent !== null && parent !== undefined) return false;
  const event = (message as { event?: { type?: string } }).event;
  return event?.type === 'message_start';
}

/**
 * Retire in-flight commands that have visibly become ordinary turn work, and
 * guarantee none can linger forever (a lingering entry pins the composer "working").
 *
 * - A top-level `message_start` retires every entry the agent has already read.
 * - A top-level `result` is the safety valve: an entry may survive one turn
 *   boundary (the fold-after-turn-end case) and no more; on a CLI that reports no
 *   lifecycle at all the first boundary retires it.
 */
export function retireInFlightCommands(
  sessionId: string,
  state: SessionState,
  message: SDKMessage
): void {
  if (state.inFlightCommands.size === 0) return;
  const isResult = message.type === 'result';
  if (!isResult && !isTopLevelMessageStart(message)) return;

  const maxTurnsWithoutReport = state.commandLifecycleSeen ? 2 : 1;
  let changed = false;
  for (const [commandUuid, command] of state.inFlightCommands) {
    const readByAgent = command.started || !state.commandLifecycleSeen;
    const retire = isResult ? ++command.resultsSeen >= maxTurnsWithoutReport : readByAgent;
    if (!retire) continue;
    state.inFlightCommands.delete(commandUuid);
    changed = true;
  }
  if (changed) sseEvents.emitPendingMessages(sessionId, pendingMessageIds(state));
}

/**
 * `Query.cancelAsyncMessage` exists at runtime but is missing from the SDK's `Query`
 * type, so it is feature-detected; an SDK without it degrades to "Stop doesn't cancel".
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

/**
 * Pull back every message we pushed that the agent hasn't read yet, deleting their
 * bubbles and handing the text/attachments back for the composer. Must run
 * **before** `interrupt()`: the abort wakes the CLI's drain loop, which starts the
 * next queued command immediately (see doc/claude-sessions.md).
 */
export async function cancelInFlightCommands(
  sessionId: string,
  state: SessionState,
  query: Query
): Promise<CancelledPrompt[]> {
  const recallable = [...state.inFlightCommands].filter(([, c]) => !c.started);
  const canceller = recallable.length > 0 ? asCancelCapable(query) : null;
  if (!canceller) return [];

  const recalled: InFlightCommand[] = [];
  const removedMessageIds: string[] = [];
  for (const [commandUuid, command] of recallable) {
    let dropped = false;
    try {
      dropped = await canceller.cancelAsyncMessage(commandUuid);
    } catch (err) {
      log.warn('cancelAsyncMessage failed', { sessionId, error: toError(err).message });
    }
    // false = the CLI already dequeued it; the agent did read it, so its bubble stays.
    if (!dropped) continue;
    state.inFlightCommands.delete(commandUuid);
    recalled.push(command);
    removedMessageIds.push(command.messageId);
  }

  if (removedMessageIds.length === 0) return [];
  await removeMessages(sessionId, removedMessageIds);
  sseEvents.emitPendingMessages(sessionId, pendingMessageIds(state));
  syncRunning(sessionId, state);

  return Promise.all(
    recalled.map(async (command) => ({
      text: command.text,
      attachments: await describeAttachments(sessionId, command.attachments),
    }))
  );
}

/**
 * Rebuild composer-ready attachment records from stored names (the display name
 * is recovered the way the chips do it; files already gone from disk are dropped).
 */
async function describeAttachments(
  sessionId: string,
  storedNames: string[]
): Promise<UploadedAttachment[]> {
  if (storedNames.length === 0) return [];
  const paths = await resolveUploadPaths(sessionId, storedNames);
  return paths.map((filePath) => {
    const storedName = basename(filePath);
    return { name: displayFileName(storedName), storedName, path: filePath };
  });
}
