import { EventEmitter } from 'events';
import type { Message, Session } from '@/generated/prisma/client';
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { RetryState } from '@/lib/claude-messages';
import { toSessionView, type SessionView } from '@/lib/session-view';
import { taskHasEndState, type BackgroundTask } from '@/lib/session-status';

// Message with parsed content (for SSE events)
type ParsedMessage = Omit<Message, 'content'> & { content: unknown };

/**
 * Everything delivered over the single multiplexed per-session SSE stream
 * (`sse.onSessionEvents`), emitted as-is on the `session:${id}` channel.
 *
 * - `message`: the id distinguishes partial (transient streaming) from complete
 *   (persisted) messages.
 * - `message_removed`: a persisted message was deleted server-side and must
 *   disappear from the transcript. Only used for a prompt cancelled by Stop before
 *   the agent read it — messages are otherwise immutable once written.
 * - `pending`: ids of persisted user messages the SDK has accepted but not yet
 *   handed to the model. The full set every time (not a delta), so a reconnecting
 *   client can't drift. See `inFlightCommands` in session-state / in-flight-commands.
 */
export type SessionStreamEvent =
  | { kind: 'message'; message: ParsedMessage }
  | { kind: 'message_removed'; messageId: string }
  | { kind: 'running'; running: boolean }
  | { kind: 'commands'; commands: SlashCommand[] }
  | { kind: 'session'; session: SessionView<Session> }
  | { kind: 'retry'; retry: RetryState | null }
  | { kind: 'background'; tasks: BackgroundTask[] }
  | { kind: 'pending'; messageIds: string[] };

/**
 * Events fanned out to the global session-list channel (`sse.onSessionListEvents`),
 * so the home page can show running/background/waiting per session without a
 * subscription per row. Payloads are deliberately lightweight: the list refetches
 * `sessions.list` on any event, which carries the authoritative state.
 *
 * - `session`: a session row changed. Only `name` rides along (the work-complete
 *   notifier needs it); the full row goes to the per-session stream.
 * - `finished`: a main-agent turn ended **naturally** (not interrupted, not
 *   stopped/torn down) and left nothing pending. Distinct from `running: false`,
 *   which also fires on interrupt/stop/error — this is the genuine "Claude
 *   finished" signal the work-complete notifier keys off of. It is the one list
 *   event a refetch can't reconstruct, so a stream `resync` (buffer overflow)
 *   can lose a notification.
 * - `background`: the session's background-task set flipped between empty and
 *   non-empty, so the badge can flip live even when the change produces no
 *   `running`/`finished` edge (the last background task settling with no
 *   main-agent continuation, or a user ✕-stopping it).
 */
export type SessionListEvent =
  | { kind: 'session'; sessionId: string; name: string }
  | { kind: 'running'; sessionId: string; running: boolean }
  | { kind: 'finished'; sessionId: string }
  | { kind: 'background'; sessionId: string; active: boolean };

// Global channel name for cross-session list updates (not session-scoped).
const SESSION_LIST_EVENT = 'session-list';

class SSEEventEmitter extends EventEmitter {
  private emitSession(sessionId: string, event: SessionStreamEvent): void {
    this.emit(`session:${sessionId}`, event);
  }

  private emitList(event: SessionListEvent): void {
    this.emit(SESSION_LIST_EVENT, event);
  }

  emitSessionUpdate(sessionId: string, row: Session): void {
    this.emitSession(sessionId, { kind: 'session', session: toSessionView(row) });
    this.emitList({ kind: 'session', sessionId, name: row.name });
  }

  emitNewMessage(sessionId: string, message: ParsedMessage): void {
    this.emitSession(sessionId, { kind: 'message', message });
  }

  emitMessageRemoved(sessionId: string, messageId: string): void {
    this.emitSession(sessionId, { kind: 'message_removed', messageId });
  }

  emitClaudeRunning(sessionId: string, running: boolean): void {
    this.emitSession(sessionId, { kind: 'running', running });
    this.emitList({ kind: 'running', sessionId, running });
  }

  /** Global-channel only — see `finished` on {@link SessionListEvent}. */
  emitClaudeFinished(sessionId: string): void {
    this.emitList({ kind: 'finished', sessionId });
  }

  emitCommands(sessionId: string, commands: SlashCommand[]): void {
    this.emitSession(sessionId, { kind: 'commands', commands });
  }

  emitClaudeRetry(sessionId: string, retry: RetryState | null): void {
    this.emitSession(sessionId, { kind: 'retry', retry });
  }

  emitBackgroundTasks(sessionId: string, tasks: BackgroundTask[]): void {
    this.emitSession(sessionId, { kind: 'background', tasks });
    // `active` mirrors the busy axis (tasks with a knowable end state only) — the
    // client refetches on any event rather than reading it, but keep it truthful.
    this.emitList({ kind: 'background', sessionId, active: tasks.some(taskHasEndState) });
  }

  emitPendingMessages(sessionId: string, messageIds: string[]): void {
    this.emitSession(sessionId, { kind: 'pending', messageIds });
  }

  onSessionEvents(sessionId: string, callback: (event: SessionStreamEvent) => void): () => void {
    const channel = `session:${sessionId}`;
    this.on(channel, callback);
    return () => this.off(channel, callback);
  }

  onSessionListChanged(callback: (event: SessionListEvent) => void): () => void {
    this.on(SESSION_LIST_EVENT, callback);
    return () => this.off(SESSION_LIST_EVENT, callback);
  }
}

// Singleton instance for the application
export const sseEvents = new SSEEventEmitter();

// Increase max listeners to handle many concurrent sessions
sseEvents.setMaxListeners(1000);
