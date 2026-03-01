import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
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
 * Merges slash command names from the system init message with rich SlashCommand
 * objects from `initializationResult().commands`.
 *
 * The SDK's `initializationResult().commands` (and `supportedCommands()`) only
 * returns "skills" — a subset of all available slash commands with rich metadata
 * (name, description, argumentHint). The system init message's `slash_commands`
 * array contains ALL available commands as bare strings.
 *
 * This function merges both: keeping the rich metadata for known skills and
 * synthesizing minimal SlashCommand objects for commands that only appear in
 * the slash_commands list.
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
    }
  }

  return merged;
}

/**
 * Options for initializing the persistent query session.
 * Passed with every query() call; used only on the first call.
 */
export interface QueryOptions {
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
 * Controller for the async generator that feeds prompts to the SDK.
 * Allows external code to yield new messages into the persistent query.
 */
interface PromptController {
  /** Yield a new user message to the query. Resolves when the SDK consumes it. */
  send(message: SDKUserMessage): void;
  /** Signal that no more messages will be sent (session ending). */
  close(): void;
}

/**
 * Creates an async generator and a controller to push messages into it.
 * The generator yields SDKUserMessages that are sent via the controller.
 */
function createPromptStream(): {
  stream: AsyncIterable<SDKUserMessage>;
  controller: PromptController;
} {
  // Queue of messages waiting to be yielded
  const queue: SDKUserMessage[] = [];
  // Resolve function for the current wait (when queue is empty and generator is waiting)
  let resolveWait: (() => void) | null = null;
  let closed = false;

  const stream: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SDKUserMessage>> {
          // If there are queued messages, yield the next one
          if (queue.length > 0) {
            return { value: queue.shift()!, done: false };
          }

          // If closed, we're done
          if (closed) {
            return { value: undefined as unknown as SDKUserMessage, done: true };
          }

          // Wait for a new message or close
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
          });

          // After waking up, check again
          if (queue.length > 0) {
            return { value: queue.shift()!, done: false };
          }

          // Must be closed
          return { value: undefined as unknown as SDKUserMessage, done: true };
        },
        async return(): Promise<IteratorResult<SDKUserMessage>> {
          closed = true;
          return { value: undefined as unknown as SDKUserMessage, done: true };
        },
        async throw(err: Error): Promise<IteratorResult<SDKUserMessage>> {
          closed = true;
          throw err;
        },
      };
    },
  };

  const controller: PromptController = {
    send(message: SDKUserMessage) {
      if (closed) {
        throw new Error('Prompt stream is closed');
      }
      queue.push(message);
      if (resolveWait) {
        const resolve = resolveWait;
        resolveWait = null;
        resolve();
      }
    },
    close() {
      closed = true;
      if (resolveWait) {
        const resolve = resolveWait;
        resolveWait = null;
        resolve();
      }
    },
  };

  return { stream, controller };
}

/**
 * Manages a persistent SDK query() session with streaming input mode.
 *
 * Instead of creating a new query() per user prompt, this class maintains
 * a single long-lived query that receives messages through an async generator.
 * This enables:
 * - Commands available at session startup (before any user message)
 * - No re-initialization per prompt
 * - Plan mode / AskUserQuestion work correctly with persistent sessions
 * - setModel() / setPermissionMode() become available
 *
 * The persistent session is auto-initialized on the first query() call.
 * Subsequent calls reuse the existing session.
 */
export class QueryRunner {
  private store: MessageStore;
  private currentQuery: Query | null = null;
  private promptController: PromptController | null = null;
  private messageCallbacks: Set<MessageCallback> = new Set();
  private partialCallbacks: Set<PartialMessageCallback> = new Set();
  private commandsCallbacks: Set<CommandsCallback> = new Set();
  private _supportedCommands: SlashCommand[] = [];
  /** Whether a user prompt is currently being processed (assistant is responding) */
  private _isProcessing = false;
  /** Whether the persistent query session is active (initialized and running) */
  private _isInitialized = false;
  /** Session ID for the persistent query */
  private _sessionId: string | null = null;
  /** Promise that resolves when the message processing loop finishes */
  private messageLoopPromise: Promise<void> | null = null;
  /** Resolves when the current turn (user prompt → result) completes */
  private turnCompleteResolve: (() => void) | null = null;

  constructor(store: MessageStore) {
    this.store = store;
  }

  /**
   * Whether a user prompt is currently being processed by the agent.
   */
  get isProcessing(): boolean {
    return this._isProcessing;
  }

  /**
   * Whether the persistent query session has been initialized.
   */
  get isInitialized(): boolean {
    return this._isInitialized;
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
   * Initialize the persistent query session.
   * Called automatically by sendQuery() on the first call.
   */
  private async initialize(options: QueryOptions): Promise<void> {
    if (this._isInitialized) {
      throw new Error('Query session is already initialized');
    }

    const { stream, controller } = createPromptStream();
    this.promptController = controller;
    this._sessionId = options.sessionId;

    const sdkOptions: Parameters<typeof query>[0]['options'] = {
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

    // Start the persistent query with the streaming input
    this.currentQuery = query({
      prompt: stream,
      options: sdkOptions,
    });

    this._isInitialized = true;

    // Fetch supported commands from the query object.
    // In streaming input mode, initializationResult() resolves before any user message.
    try {
      let commands: SlashCommand[] = [];

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

    // Start the message processing loop in the background.
    // This loop runs for the lifetime of the persistent query, processing
    // messages from all user prompts.
    this.messageLoopPromise = this.processMessages();
    // Attach error handler to prevent unhandled rejection
    this.messageLoopPromise.catch((err) => {
      log.error('Message processing loop failed', toError(err));
    });

    log.info('Persistent query session initialized', { sessionId: options.sessionId });
  }

  /**
   * Send a query to the persistent session.
   * Auto-initializes the session on the first call using the provided options.
   * On subsequent calls, the init options are ignored (session is already initialized).
   *
   * Returns a promise that resolves when the turn completes (result message received).
   * Throws if a prompt is already being processed.
   */
  async sendQuery(prompt: string, sessionId: string, options: QueryOptions): Promise<void> {
    if (this._isProcessing) {
      throw new Error('A prompt is already being processed');
    }

    // Set processing flag early to prevent concurrent calls during initialization
    this._isProcessing = true;

    try {
      // Auto-initialize on first call
      if (!this._isInitialized) {
        await this.initialize(options);
      }

      if (!this.promptController) {
        throw new Error('Query session failed to initialize');
      }

      // Create a promise that resolves when the turn completes
      const turnComplete = new Promise<void>((resolve) => {
        this.turnCompleteResolve = resolve;
      });

      // Create the SDKUserMessage to yield to the SDK
      const userMessage: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: prompt,
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      };

      // Yield the message to the SDK
      this.promptController.send(userMessage);

      // Wait for the turn to complete (result message received)
      await turnComplete;
    } finally {
      this._isProcessing = false;
      this.turnCompleteResolve = null;
    }
  }

  /**
   * Process messages from the SDK query in a long-running loop.
   * This runs for the lifetime of the persistent query session.
   */
  private async processMessages(): Promise<void> {
    if (!this.currentQuery || !this._sessionId) {
      throw new Error('No active query');
    }

    const accumulator = new StreamAccumulator();

    try {
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
        const sequence = this.store.append(this._sessionId, type, content);

        // Notify all connected SSE clients
        for (const callback of this.messageCallbacks) {
          try {
            callback(sequence, message);
          } catch {
            // Don't let callback errors break the query loop
          }
        }

        // Extract slash_commands from system init messages and merge with
        // existing commands. The SDK's initializationResult().commands only
        // returns "skills", but the system init message contains all slash
        // commands. See: https://github.com/brendanlong/clawed-abode/issues/294
        if (
          message.type === 'system' &&
          'subtype' in message &&
          message.subtype === 'init' &&
          'slash_commands' in message &&
          Array.isArray(message.slash_commands)
        ) {
          const merged = mergeSlashCommands(
            this._supportedCommands,
            message.slash_commands as string[]
          );
          if (merged.length > this._supportedCommands.length) {
            log.info('Merged slash_commands from system init message', {
              before: this._supportedCommands.length,
              after: merged.length,
              slashCommands: message.slash_commands.length,
            });
            this._supportedCommands = merged;
            for (const callback of this.commandsCallbacks) {
              try {
                callback(merged);
              } catch {
                // Don't let callback errors break the query loop
              }
            }
          }
        }

        // When a result message arrives, the turn is complete.
        // Signal the waiting sendQuery() call.
        if (message.type === 'result') {
          if (this.turnCompleteResolve) {
            this.turnCompleteResolve();
          }
        }
      }
    } finally {
      log.info('Message processing loop ended', { sessionId: this._sessionId });
      this._isInitialized = false;
      this.currentQuery = null;
      this.promptController = null;
      // If a prompt was in progress, resolve it so it doesn't hang
      if (this.turnCompleteResolve) {
        this.turnCompleteResolve();
      }
    }
  }

  /**
   * Interrupt the currently running query.
   * Uses the SDK's interrupt() method for clean interruption.
   */
  async interrupt(): Promise<boolean> {
    if (!this._isInitialized || !this.currentQuery) {
      return false;
    }

    try {
      await this.currentQuery.interrupt();
      return true;
    } catch (err) {
      log.warn('Interrupt failed', undefined, toError(err));
      return false;
    }
  }

  /**
   * Shut down the persistent query session.
   * Closes the prompt stream and waits for the message loop to finish.
   */
  async shutdown(): Promise<void> {
    if (!this._isInitialized) {
      return;
    }

    log.info('Shutting down persistent query session', { sessionId: this._sessionId });

    // Close the prompt stream, which will end the query
    if (this.promptController) {
      this.promptController.close();
    }

    // Close the query
    if (this.currentQuery) {
      this.currentQuery.close();
    }

    // Wait for the message loop to finish
    if (this.messageLoopPromise) {
      try {
        await this.messageLoopPromise;
      } catch {
        // Expected - the loop may error when the query is closed
      }
    }

    this._isInitialized = false;
    this.currentQuery = null;
    this.promptController = null;
    this._sessionId = null;
    this.messageLoopPromise = null;
  }
}
