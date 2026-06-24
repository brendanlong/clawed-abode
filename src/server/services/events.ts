import { EventEmitter } from 'events';
import type { Message, Session } from '@prisma/client';
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { PullRequestInfo } from './github';
import type { RetryState } from '@/lib/claude-messages';
import type { BackgroundTask } from '@/lib/session-status';

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

export type SSEEvent =
  | SessionUpdateEvent
  | MessageEvent
  | ClaudeRunningEvent
  | CommandsEvent
  | PrUpdateEvent
  | ClaudeRetryEvent
  | BackgroundTasksEvent;

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
  | { kind: 'background'; tasks: BackgroundTask[] };

// Global channel name for cross-session list updates (not session-scoped).
const SESSION_LIST_EVENT = 'session-list';

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
    this.emit(`claude:${sessionId}`, {
      type: 'claude_running',
      sessionId,
      running,
    } satisfies ClaudeRunningEvent);
  }

  emitCommands(sessionId: string, commands: SlashCommand[]): void {
    this.emit(`commands:${sessionId}`, {
      type: 'commands',
      sessionId,
      commands,
    } satisfies CommandsEvent);
  }

  // Subscribe to session updates for a specific session
  onSessionUpdate(sessionId: string, callback: (event: SessionUpdateEvent) => void): () => void {
    const eventName = `session:${sessionId}`;
    this.on(eventName, callback);
    return () => this.off(eventName, callback);
  }

  // Subscribe to new messages for a specific session
  onNewMessage(sessionId: string, callback: (event: MessageEvent) => void): () => void {
    const eventName = `messages:${sessionId}`;
    this.on(eventName, callback);
    return () => this.off(eventName, callback);
  }

  // Subscribe to Claude running state changes for a specific session
  onClaudeRunning(sessionId: string, callback: (event: ClaudeRunningEvent) => void): () => void {
    const eventName = `claude:${sessionId}`;
    this.on(eventName, callback);
    return () => this.off(eventName, callback);
  }

  // Subscribe to commands updates for a specific session
  onCommands(sessionId: string, callback: (event: CommandsEvent) => void): () => void {
    const eventName = `commands:${sessionId}`;
    this.on(eventName, callback);
    return () => this.off(eventName, callback);
  }

  emitPrUpdate(sessionId: string, pullRequest: PullRequestInfo | null): void {
    this.emit(`pr:${sessionId}`, {
      type: 'pr_update',
      sessionId,
      pullRequest,
    } satisfies PrUpdateEvent);
  }

  onPrUpdate(sessionId: string, callback: (event: PrUpdateEvent) => void): () => void {
    const eventName = `pr:${sessionId}`;
    this.on(eventName, callback);
    return () => this.off(eventName, callback);
  }

  emitClaudeRetry(sessionId: string, retry: RetryState | null): void {
    this.emit(`retry:${sessionId}`, {
      type: 'claude_retry',
      sessionId,
      retry,
    } satisfies ClaudeRetryEvent);
  }

  onClaudeRetry(sessionId: string, callback: (event: ClaudeRetryEvent) => void): () => void {
    const eventName = `retry:${sessionId}`;
    this.on(eventName, callback);
    return () => this.off(eventName, callback);
  }

  emitBackgroundTasks(sessionId: string, tasks: BackgroundTask[]): void {
    this.emit(`background:${sessionId}`, {
      type: 'background_tasks',
      sessionId,
      tasks,
    } satisfies BackgroundTasksEvent);
  }

  onBackgroundTasks(
    sessionId: string,
    callback: (event: BackgroundTasksEvent) => void
  ): () => void {
    const eventName = `background:${sessionId}`;
    this.on(eventName, callback);
    return () => this.off(eventName, callback);
  }

  /**
   * Subscribe to all event kinds for a session as a single normalized stream.
   * Returns one unsubscribe that detaches every underlying channel listener.
   */
  onSessionEvents(sessionId: string, callback: (event: SessionStreamEvent) => void): () => void {
    const unsubscribes = [
      this.onNewMessage(sessionId, (e) => callback({ kind: 'message', message: e.message })),
      this.onClaudeRunning(sessionId, (e) => callback({ kind: 'running', running: e.running })),
      this.onCommands(sessionId, (e) => callback({ kind: 'commands', commands: e.commands })),
      this.onPrUpdate(sessionId, (e) => callback({ kind: 'pr', pullRequest: e.pullRequest })),
      this.onSessionUpdate(sessionId, (e) => callback({ kind: 'session', session: e.session })),
      this.onClaudeRetry(sessionId, (e) => callback({ kind: 'retry', retry: e.retry })),
      this.onBackgroundTasks(sessionId, (e) => callback({ kind: 'background', tasks: e.tasks })),
    ];
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }

  // Subscribe to session list changes across all sessions (home page).
  onSessionListChanged(callback: (event: SessionUpdateEvent) => void): () => void {
    this.on(SESSION_LIST_EVENT, callback);
    return () => this.off(SESSION_LIST_EVENT, callback);
  }
}

// Singleton instance for the application
export const sseEvents = new SSEEventEmitter();

// Increase max listeners to handle many concurrent sessions
sseEvents.setMaxListeners(1000);
