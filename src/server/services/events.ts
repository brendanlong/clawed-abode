import { EventEmitter } from 'events';
import type { Session } from '@/generated/prisma/client';
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { RetryState } from '@/lib/claude-messages';
import type { PermissionRequest } from '@/lib/permission-request';
import type { RateLimitHold } from '@/lib/rate-limit';
import type { TokenUsageStats } from '@/lib/token-estimation';
import { toSessionView, type SessionView } from '@/lib/session-view';
import { processSingleton } from '@/lib/process-singleton';
import type { BackgroundTask } from '@/lib/session-status';
import type { ParsedMessage } from './message-store';

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
 *   client can't drift. See `inFlight` in src/lib/live-turn.ts.
 * - `queued`: ids of persisted user messages held back by a rate-limit pause,
 *   likewise the full set. Distinct from `pending`: those are with the SDK, these
 *   have never left the server (see doc/rate-limit-pause.md).
 * - `rate_limit`: this session's rate-limit hold, or null when it may work.
 * - `token_usage`: the session's token/cost stats, after a persisted message moved them.
 * - `permissions`: tool calls waiting for the user to allow or deny them, the full set.
 */
export type SessionStreamEvent =
  | { kind: 'message'; message: ParsedMessage }
  | { kind: 'message_removed'; messageId: string }
  | { kind: 'running'; running: boolean }
  | { kind: 'commands'; commands: SlashCommand[] }
  | { kind: 'session'; session: SessionView<Session> }
  | { kind: 'retry'; retry: RetryState | null }
  | { kind: 'background'; tasks: BackgroundTask[] }
  | { kind: 'pending'; messageIds: string[] }
  | { kind: 'queued'; messageIds: string[] }
  | { kind: 'rate_limit'; hold: RateLimitHold | null }
  | { kind: 'token_usage'; usage: TokenUsageStats }
  | { kind: 'permissions'; requests: PermissionRequest[] };

/**
 * Events fanned out to the global session-list channel (`sse.onSessionListEvents`),
 * so the home page can show running/background/waiting per session without a
 * subscription per row. The list refetches `sessions.list`, which carries the
 * authoritative state, on any event, so `changed` carries only the session id.
 *
 * - `changed`: the session's row, turn state, background-task set, or rate-limit
 *   hold changed.
 * - `attention`: the agent asked for the user (doc/claude-sessions.md, "Needs
 *   You"). The row change also arrives as `changed`; this edge is what fires the
 *   notification, so a stream `resync` (buffer overflow) can lose one — the list
 *   badge still shows it.
 */
export type SessionListEvent =
  | { kind: 'changed'; sessionId: string }
  | { kind: 'attention'; sessionId: string; name: string; summary: string };

// Global channel name for cross-session list updates (not session-scoped).
const SESSION_LIST_EVENT = 'session-list';

class SSEEventEmitter {
  constructor(private readonly bus: EventEmitter) {}

  private emitSession(sessionId: string, event: SessionStreamEvent): void {
    this.bus.emit(`session:${sessionId}`, event);
  }

  private emitList(event: SessionListEvent): void {
    this.bus.emit(SESSION_LIST_EVENT, event);
  }

  emitSessionUpdate(sessionId: string, row: Session): void {
    this.emitSession(sessionId, { kind: 'session', session: toSessionView(row) });
    this.emitList({ kind: 'changed', sessionId });
  }

  emitNewMessage(sessionId: string, message: ParsedMessage): void {
    this.emitSession(sessionId, { kind: 'message', message });
  }

  emitMessageRemoved(sessionId: string, messageId: string): void {
    this.emitSession(sessionId, { kind: 'message_removed', messageId });
  }

  emitClaudeRunning(sessionId: string, running: boolean): void {
    this.emitSession(sessionId, { kind: 'running', running });
    this.emitList({ kind: 'changed', sessionId });
  }

  /** Global-channel only — see `attention` on {@link SessionListEvent}. */
  emitAttention(sessionId: string, name: string, summary: string): void {
    this.emitList({ kind: 'attention', sessionId, name, summary });
  }

  emitCommands(sessionId: string, commands: SlashCommand[]): void {
    this.emitSession(sessionId, { kind: 'commands', commands });
  }

  emitClaudeRetry(sessionId: string, retry: RetryState | null): void {
    this.emitSession(sessionId, { kind: 'retry', retry });
  }

  emitBackgroundTasks(sessionId: string, tasks: BackgroundTask[]): void {
    this.emitSession(sessionId, { kind: 'background', tasks });
    this.emitList({ kind: 'changed', sessionId });
  }

  emitPermissionRequests(sessionId: string, requests: PermissionRequest[]): void {
    this.emitSession(sessionId, { kind: 'permissions', requests });
  }

  emitPendingMessages(sessionId: string, messageIds: string[]): void {
    this.emitSession(sessionId, { kind: 'pending', messageIds });
  }

  emitQueuedMessages(sessionId: string, messageIds: string[]): void {
    this.emitSession(sessionId, { kind: 'queued', messageIds });
  }

  emitRateLimitHold(sessionId: string, hold: RateLimitHold | null): void {
    this.emitSession(sessionId, { kind: 'rate_limit', hold });
    this.emitList({ kind: 'changed', sessionId });
  }

  emitTokenUsage(sessionId: string, usage: TokenUsageStats): void {
    this.emitSession(sessionId, { kind: 'token_usage', usage });
  }

  onSessionEvents(sessionId: string, callback: (event: SessionStreamEvent) => void): () => void {
    const channel = `session:${sessionId}`;
    this.bus.on(channel, callback);
    return () => this.bus.off(channel, callback);
  }

  onSessionListChanged(callback: (event: SessionListEvent) => void): () => void {
    this.bus.on(SESSION_LIST_EVENT, callback);
    return () => this.bus.off(SESSION_LIST_EVENT, callback);
  }
}

export const sseEvents = new SSEEventEmitter(
  processSingleton('sse-events', () => {
    const bus = new EventEmitter();
    // Every open session view and session list subscribes.
    bus.setMaxListeners(1000);
    return bus;
  })
);
