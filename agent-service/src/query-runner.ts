import {
  query,
  type Query,
  type SDKMessage,
  type McpServerConfig,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { MessageStore } from './message-store.js';
import { StreamAccumulator, type PartialAssistantMessage } from './stream-accumulator.js';
import { createLogger, toError } from './logger.js';

const log = createLogger('query-runner');

/**
 * Extracts the message type from an SDKMessage for storage categorization.
 */
function getMessageType(message: SDKMessage): string {
  if (message.type === 'stream_event') return 'stream_event';
  return message.type;
}

/**
 * Options for starting a new query.
 */
export interface QueryOptions {
  prompt: string;
  sessionId: string;
  /** If true, resume the session instead of starting a new one */
  resume: boolean;
  /** System prompt to use */
  systemPrompt?: string;
  /** Model to use */
  model?: string;
  /** Working directory */
  cwd?: string;
  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Callback for when a new message is stored (complete messages only).
 * Used by the HTTP server to push messages to connected SSE clients.
 */
export type MessageCallback = (sequence: number, message: SDKMessage) => void;

/**
 * Callback for partial (streaming) assistant message updates.
 * These are transient and not persisted to the database.
 * The uuid field links the partial to the stream that produced it;
 * the final AssistantMessage will have a different uuid.
 */
export type PartialMessageCallback = (partial: PartialAssistantMessage) => void;

/**
 * Callback for when supported slash commands are detected.
 * Called after each query() call when commands are retrieved from the SDK.
 */
export type CommandsCallback = (commands: SlashCommand[]) => void;

/**
 * Manages SDK query() execution with message persistence.
 * Only one query can run at a time per QueryRunner instance.
 */
export class QueryRunner {
  private store: MessageStore;
  private currentQuery: Query | null = null;
  private currentAbortController: AbortController | null = null;
  private running = false;
  private messageCallbacks: Set<MessageCallback> = new Set();
  private partialCallbacks: Set<PartialMessageCallback> = new Set();
  private commandsCallbacks: Set<CommandsCallback> = new Set();
  private _supportedCommands: SlashCommand[] = [];

  constructor(store: MessageStore) {
    this.store = store;
  }

  /**
   * Whether a query is currently running.
   */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Subscribe to new complete messages. Returns an unsubscribe function.
   */
  onMessage(callback: MessageCallback): () => void {
    this.messageCallbacks.add(callback);
    return () => {
      this.messageCallbacks.delete(callback);
    };
  }

  /**
   * Subscribe to partial (streaming) message updates. Returns an unsubscribe function.
   * Partials are emitted as stream_events are accumulated, providing real-time UI updates.
   */
  onPartialMessage(callback: PartialMessageCallback): () => void {
    this.partialCallbacks.add(callback);
    return () => {
      this.partialCallbacks.delete(callback);
    };
  }

  /**
   * Subscribe to supported commands updates. Returns an unsubscribe function.
   * Commands are detected after each query() call completes its first iteration.
   */
  onCommands(callback: CommandsCallback): () => void {
    this.commandsCallbacks.add(callback);
    return () => {
      this.commandsCallbacks.delete(callback);
    };
  }

  /**
   * Get the currently known supported slash commands.
   */
  get supportedCommands(): SlashCommand[] {
    return this._supportedCommands;
  }

  /**
   * Start a new query. Throws if a query is already running.
   * This method runs the query to completion and returns when done.
   */
  async run(options: QueryOptions): Promise<void> {
    if (this.running) {
      throw new Error('A query is already running');
    }

    this.running = true;
    this.currentAbortController = new AbortController();
    const accumulator = new StreamAccumulator();

    try {
      const sdkOptions: Parameters<typeof query>[0]['options'] = {
        abortController: this.currentAbortController,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        // Enable partial message streaming for real-time UI updates
        includePartialMessages: true,
      };

      // System prompt configuration
      if (options.systemPrompt) {
        sdkOptions.systemPrompt = {
          type: 'preset' as const,
          preset: 'claude_code' as const,
          append: options.systemPrompt,
        };
      } else {
        sdkOptions.systemPrompt = {
          type: 'preset' as const,
          preset: 'claude_code' as const,
        };
      }

      // Tools configuration - use Claude Code preset
      sdkOptions.tools = { type: 'preset' as const, preset: 'claude_code' as const };

      // Resume or start fresh
      // We use our own sessionId so resume can find it by the same ID
      if (options.resume) {
        sdkOptions.resume = options.sessionId;
      } else {
        sdkOptions.sessionId = options.sessionId;
      }

      // Model configuration
      if (options.model) {
        sdkOptions.model = options.model;
      }

      // Working directory
      if (options.cwd) {
        sdkOptions.cwd = options.cwd;
      }

      // MCP server configurations
      if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
        sdkOptions.mcpServers = options.mcpServers;
      }

      // Load project settings (for CLAUDE.md)
      sdkOptions.settingSources = ['project'];

      this.currentQuery = query({
        prompt: options.prompt,
        options: sdkOptions,
      });

      // Fetch supported commands from the query object.
      // We try initializationResult() first (which includes commands along with
      // other init data), then fall back to supportedCommands().
      // We await this before iterating messages so the commands are available
      // to send via SSE while the response is still open.
      try {
        let commands: SlashCommand[] = [];

        // Try initializationResult() first - it returns the full init response
        // including commands from the SDK control channel
        try {
          const initResult = await this.currentQuery.initializationResult();
          commands = initResult.commands ?? [];
          log.debug('initializationResult() returned commands', { count: commands.length });
        } catch (initErr) {
          log.warn(
            'initializationResult() failed, trying supportedCommands()',
            undefined,
            toError(initErr)
          );
          // Fall back to supportedCommands()
          commands = await this.currentQuery.supportedCommands();
          log.debug('supportedCommands() returned commands', { count: commands.length });
        }

        if (commands.length > 0) {
          this._supportedCommands = commands;
          for (const callback of this.commandsCallbacks) {
            try {
              callback(commands);
            } catch {
              // Don't let callback errors break anything
            }
          }
        }
      } catch (err) {
        log.error('Failed to fetch supported commands', toError(err));
      }

      // Iterate through all messages from the SDK
      for await (const message of this.currentQuery) {
        // Handle stream_events: accumulate into partial messages for real-time UI
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
            for (const callback of this.partialCallbacks) {
              try {
                callback(partial);
              } catch {
                // Don't let callback errors break the query loop
              }
            }
          }
          // Don't store stream_events in the database - they're transient
          continue;
        }

        // For complete messages (assistant, user, result, system, etc.):
        // Reset the accumulator when a full assistant message arrives
        if (message.type === 'assistant') {
          accumulator.reset();
        }

        const type = getMessageType(message);
        const content = JSON.stringify(message);
        const sequence = this.store.append(options.sessionId, type, content);

        // Notify all connected SSE clients
        for (const callback of this.messageCallbacks) {
          try {
            callback(sequence, message);
          } catch {
            // Don't let callback errors break the query loop
          }
        }
      }
    } finally {
      this.running = false;
      this.currentQuery = null;
      this.currentAbortController = null;
    }
  }

  /**
   * Interrupt the currently running query.
   * Uses the SDK's interrupt() method for clean interruption.
   */
  async interrupt(): Promise<boolean> {
    if (!this.running || !this.currentQuery) {
      return false;
    }

    try {
      await this.currentQuery.interrupt();
      return true;
    } catch {
      // If interrupt fails, try aborting via the controller
      if (this.currentAbortController) {
        this.currentAbortController.abort();
        return true;
      }
      return false;
    }
  }
}
