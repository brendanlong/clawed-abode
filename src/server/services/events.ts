import { EventEmitter } from 'events';
import type { Message, Session } from '@prisma/client';
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { PullRequestInfo } from './github';
import type { RetryState } from '@/lib/claude-messages';
import type { BackgroundTask } from '@/lib/session-status';
import type { QueuedMessage } from '@/lib/queued-message';

// Message with parsed content (for SSE events)
export type ParsedMessage = Omit<Message, 'content'> & { content: unknown };

// Event types for type-safe event handling
export interface SessionUpdateEvent {
  type: 'session_update';
  sessionId: string;
  session: Session;
}

export interface MessageEvent {
  type: 'new_message';
  sessionId: string;
  message: ParsedMessage;
}

export interface ClaudeRunningEvent {
  type: 'claude_running';
  sessionId: string;
  running: boolean;
}

export interface CommandsEvent {
  type: 'commands';
  sessionId: string;
  commands: SlashCommand[];
}

export interface PrUpdateEvent {
  type: 'pr_update';
  sessionId: string;
  pullRequest: PullRequestInfo | null;
}

export interface ClaudeRetryEvent {
  type: 'claude_retry';
  sessionId: string;
  retry: RetryState | null;
}

export interface BackgroundTasksEvent {
  type: 'background_tasks';
  sessionId: string;
  tasks: BackgroundTask[];
}

export interface QueuedMessagesEvent {
  type: 'queued_messages';
  sessionId: string;
  messages: QueuedMessage[];
}

/**
 * Normalized union delivered over the single multiplexed per-session SSE stream.
 * The five per-channel events above are folded into this discriminated union by
 * {@link SSEEventEmitter.onSessionEvents}. A `message`'s id distinguishes partial
 * (transient streaming) from complete (persisted) messages.
 */
export type SessionStreamEvent =
  | { kind: 'message'; message: ParsedMessage }
  | { kind: 'running'; running: boolean }
  | { kind: 'commands'; commands: SlashCommand[] }
  | { kind: 'pr'; pullRequest: PullRequestInfo | null }
  | { kind: 'session'; session: Session }
  | { kind: 'retry'; retry: RetryState | null }
  | { kind: 'background'; tasks: BackgroundTask[] }
  | { kind: 'queued'; messages: QueuedMessage[] };

// Global channel name for cross-session list updates (not session-scoped).
const SESSION_LIST_EVENT = 'session-list';

/**
 * Events fanned out to the global session-list channel: session record changes
 * plus main-agent running-state changes, so the home page can show
 * running/waiting per session without a subscription per row.
 */
export type SessionListEvent = SessionUpdateEvent | ClaudeRunningEvent;

// Create a typed event emitter
class SSEEventEmitter extends EventEmitter {
  emitSessionUpdate(sessionId: string, session: Session): void {
    this.emit(`session:${sessionId}`, {
      type: 'session_update',
      sessionId,
      session,
    } satisfies SessionUpdateEvent);
    // Fan out to the global list channel so the home page updates live for any
    // session, without each row needing its own subscription.
    this.emit(SESSION_LIST_EVENT, {
      type: 'session_update',
      sessionId,
      session,
    } satisfies SessionUpdateEvent);
  }

  emitNewMessage(sessionId: string, message: ParsedMessage): void {
    this.emit(`messages:${sessionId}`, {
      type: 'new_message',
      sessionId,
      message,
    } satisfies MessageEvent);
  }

  emitClaudeRunning(sessionId: string, running: boolean): void {
    const event: ClaudeRunningEvent = {
      type: 'claude_running',
      sessionId,
      running,
    };
    this.emit(`claude:${sessionId}`, event);
    // Fan out to the global list channel so the home page can flip a session
    // between "running" and "waiting" live.
    this.emit(SESSION_LIST_EVENT, event);
  }

  emitCommands(sessionId: string, commands: SlashCommand[]): void {
    this.emit(`commands:${sessionId}`, {
      type: 'commands',
      sessionId,
      commands,
    } satisfies CommandsEvent);
  }

  emitPrUpdate(sessionId: string, pullRequest: PullRequestInfo | null): void {
    this.emit(`pr:${sessionId}`, {
      type: 'pr_update',
      sessionId,
      pullRequest,
    } satisfies PrUpdateEvent);
  }

  emitClaudeRetry(sessionId: string, retry: RetryState | null): void {
    this.emit(`retry:${sessionId}`, {
      type: 'claude_retry',
      sessionId,
      retry,
    } satisfies ClaudeRetryEvent);
  }

  emitBackgroundTasks(sessionId: string, tasks: BackgroundTask[]): void {
    this.emit(`background:${sessionId}`, {
      type: 'background_tasks',
      sessionId,
      tasks,
    } satisfies BackgroundTasksEvent);
  }

  emitQueuedMessages(sessionId: string, messages: QueuedMessage[]): void {
    this.emit(`queued:${sessionId}`, {
      type: 'queued_messages',
      sessionId,
      messages,
    } satisfies QueuedMessagesEvent);
  }

  /**
   * Subscribe to a single per-session EventEmitter channel, returning an
   * unsubscribe. The channel payloads are the typed `*Event` interfaces above;
   * the caller maps them into the normalized {@link SessionStreamEvent} union.
   */
  private onChannel<E>(channel: string, callback: (event: E) => void): () => void {
    this.on(channel, callback);
    return () => this.off(channel, callback);
  }

  /**
   * Subscribe to all event kinds for a session as a single normalized stream.
   * Returns one unsubscribe that detaches every underlying channel listener.
   */
  onSessionEvents(sessionId: string, callback: (event: SessionStreamEvent) => void): () => void {
    const unsubscribes = [
      this.onChannel<MessageEvent>(`messages:${sessionId}`, (e) =>
        callback({ kind: 'message', message: e.message })
      ),
      this.onChannel<ClaudeRunningEvent>(`claude:${sessionId}`, (e) =>
        callback({ kind: 'running', running: e.running })
      ),
      this.onChannel<CommandsEvent>(`commands:${sessionId}`, (e) =>
        callback({ kind: 'commands', commands: e.commands })
      ),
      this.onChannel<PrUpdateEvent>(`pr:${sessionId}`, (e) =>
        callback({ kind: 'pr', pullRequest: e.pullRequest })
      ),
      this.onChannel<SessionUpdateEvent>(`session:${sessionId}`, (e) =>
        callback({ kind: 'session', session: e.session })
      ),
      this.onChannel<ClaudeRetryEvent>(`retry:${sessionId}`, (e) =>
        callback({ kind: 'retry', retry: e.retry })
      ),
      this.onChannel<BackgroundTasksEvent>(`background:${sessionId}`, (e) =>
        callback({ kind: 'background', tasks: e.tasks })
      ),
      this.onChannel<QueuedMessagesEvent>(`queued:${sessionId}`, (e) =>
        callback({ kind: 'queued', messages: e.messages })
      ),
    ];
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }

  // Subscribe to session list changes across all sessions (home page).
  onSessionListChanged(callback: (event: SessionListEvent) => void): () => void {
    this.on(SESSION_LIST_EVENT, callback);
    return () => this.off(SESSION_LIST_EVENT, callback);
  }
}

// Singleton instance for the application
export const sseEvents = new SSEEventEmitter();

// Increase max listeners to handle many concurrent sessions
sseEvents.setMaxListeners(1000);
