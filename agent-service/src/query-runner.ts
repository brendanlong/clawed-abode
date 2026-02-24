import {
  query,
  type Query,
  type SDKMessage,
  type McpServerConfig,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
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
 * Tool names that require user input via the canUseTool callback.
 * When Claude calls these tools, execution pauses until the user responds.
 */
const USER_INPUT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * All standard Claude Code tools that should be auto-allowed without permission prompts.
 * Tools NOT in this list (specifically AskUserQuestion and ExitPlanMode) will trigger
 * the canUseTool callback, enabling interactive approval flows.
 *
 * We use permissionMode 'default' + allowedTools instead of 'bypassPermissions' because
 * bypassPermissions causes the SDK's internal permission flow to auto-deny interactive
 * tools (those with requiresUserInteraction) without routing through the canUseTool callback.
 */
const ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TodoWrite',
  'NotebookEdit',
  'Skill',
  'EnterPlanMode',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
];

/**
 * An input request emitted when the SDK calls a tool that needs user input.
 * The HTTP server surfaces this to clients, who respond via POST /respond.
 */
export interface InputRequest {
  /** Unique ID for this request, used to match the response */
  requestId: string;
  /** The tool that triggered the input request */
  toolName: string;
  /** The tool's input parameters */
  toolInput: Record<string, unknown>;
  /** The tool use ID from the SDK */
  toolUseId: string;
}

/**
 * The user's response to an input request.
 */
export interface InputResponse {
  /** Must match the requestId from the InputRequest */
  requestId: string;
  /** 'allow' to proceed with (optionally modified) input, 'deny' to reject */
  behavior: 'allow' | 'deny';
  /** For 'allow': optionally updated tool input */
  updatedInput?: Record<string, unknown>;
  /** For 'deny': message explaining why */
  message?: string;
}

/**
 * Callback for when the SDK needs user input (via canUseTool).
 */
export type InputRequestCallback = (request: InputRequest) => void;

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
  private inputRequestCallbacks: Set<InputRequestCallback> = new Set();
  private _supportedCommands: SlashCommand[] = [];

  /**
   * Currently pending input request, if any.
   * When the canUseTool callback fires for a user-input tool,
   * we store the resolve function here so POST /respond can fulfill it.
   */
  private pendingInputRequest: {
    requestId: string;
    resolve: (response: InputResponse) => void;
  } | null = null;

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
   * Get the currently pending input request, if any.
   */
  get currentInputRequest(): InputRequest | null {
    return this.pendingInputRequest
      ? {
          requestId: this.pendingInputRequest.requestId,
          toolName: '',
          toolInput: {},
          toolUseId: '',
        }
      : null;
  }

  /**
   * Whether there is a pending input request waiting for a user response.
   */
  get hasPendingInputRequest(): boolean {
    return this.pendingInputRequest !== null;
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
   * Subscribe to input request events. Returns an unsubscribe function.
   * Called when Claude calls a tool that needs user input (AskUserQuestion, ExitPlanMode).
   */
  onInputRequest(callback: InputRequestCallback): () => void {
    this.inputRequestCallbacks.add(callback);
    return () => {
      this.inputRequestCallbacks.delete(callback);
    };
  }

  /**
   * Get the currently known supported slash commands.
   */
  get supportedCommands(): SlashCommand[] {
    return this._supportedCommands;
  }

  /**
   * Resolve a pending input request with a user response.
   * Called by the HTTP server when it receives POST /respond.
   * Returns true if a pending request was resolved, false otherwise.
   */
  respond(response: InputResponse): boolean {
    if (!this.pendingInputRequest) {
      log.warn('respond: No pending input request');
      return false;
    }

    if (this.pendingInputRequest.requestId !== response.requestId) {
      log.warn('respond: Request ID mismatch', {
        expected: this.pendingInputRequest.requestId,
        received: response.requestId,
      });
      return false;
    }

    log.info('respond: Resolving pending input request', {
      requestId: response.requestId,
      behavior: response.behavior,
    });

    this.pendingInputRequest.resolve(response);
    this.pendingInputRequest = null;
    return true;
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
        // Use 'default' permission mode with allowedTools to auto-allow standard tools
        // while routing interactive tools (AskUserQuestion, ExitPlanMode) through canUseTool.
        // We avoid 'bypassPermissions' because it causes the SDK's internal CLI to
        // auto-deny interactive tools without sending them through the IPC callback.
        permissionMode: 'default' as const,
        allowedTools: ALLOWED_TOOLS,
        // Enable partial message streaming for real-time UI updates
        includePartialMessages: true,
        // canUseTool callback: called for tools NOT in allowedTools.
        // For interactive tools (AskUserQuestion, ExitPlanMode), this pauses execution
        // until the user responds via the web UI. For any other tool that somehow
        // isn't in allowedTools, we auto-allow it.
        canUseTool: async (toolName, toolInput, callbackOptions) => {
          if (!USER_INPUT_TOOLS.has(toolName)) {
            // Auto-allow any tool not in ALLOWED_TOOLS (e.g. MCP tools, new tools)
            log.debug('canUseTool: Auto-allowing tool', { toolName });
            return { behavior: 'allow' as const, updatedInput: toolInput };
          }

          log.info('canUseTool: User input required', {
            toolName,
            toolUseId: callbackOptions.toolUseID,
          });

          const requestId = randomUUID();
          const request: InputRequest = {
            requestId,
            toolName,
            toolInput,
            toolUseId: callbackOptions.toolUseID,
          };

          // Create a promise that will be resolved when the user responds
          const responsePromise = new Promise<InputResponse>((resolve) => {
            this.pendingInputRequest = { requestId, resolve };
          });

          // Notify all listeners that input is needed
          for (const callback of this.inputRequestCallbacks) {
            try {
              callback(request);
            } catch {
              // Don't let callback errors break the flow
            }
          }

          // Wait for the user to respond (via POST /respond)
          const response = await responsePromise;

          if (response.behavior === 'allow') {
            return {
              behavior: 'allow' as const,
              updatedInput: response.updatedInput ?? toolInput,
            };
          } else {
            return {
              behavior: 'deny' as const,
              message: response.message ?? 'User denied this action',
            };
          }
        },
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
      // Clean up any pending input request that was never resolved
      if (this.pendingInputRequest) {
        log.warn('run: Query ended with unresolved input request', {
          requestId: this.pendingInputRequest.requestId,
        });
        this.pendingInputRequest = null;
      }
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

    // If there's a pending input request, reject it so the canUseTool promise
    // resolves and the query can proceed to handle the interruption
    if (this.pendingInputRequest) {
      log.info('interrupt: Rejecting pending input request', {
        requestId: this.pendingInputRequest.requestId,
      });
      this.pendingInputRequest.resolve({
        requestId: this.pendingInputRequest.requestId,
        behavior: 'deny',
        message: 'Interrupted by user',
      });
      this.pendingInputRequest = null;
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
