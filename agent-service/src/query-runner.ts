import {
  query,
  type Query,
  type SDKMessage,
  type McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { MessageStore } from './message-store.js';

/**
 * Extracts the message type from an SDKMessage for storage categorization.
 */
function getMessageType(message: SDKMessage): string {
  return message.type === 'stream_event' ? 'stream_event' : message.type;
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
 * Callback for when a new message is stored.
 * Used by the HTTP server to push messages to connected SSE clients.
 */
export type MessageCallback = (sequence: number, message: SDKMessage) => void;

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
   * Subscribe to new messages. Returns an unsubscribe function.
   */
  onMessage(callback: MessageCallback): () => void {
    this.messageCallbacks.add(callback);
    return () => {
      this.messageCallbacks.delete(callback);
    };
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

    try {
      const sdkOptions: Parameters<typeof query>[0]['options'] = {
        abortController: this.currentAbortController,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
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

      // Iterate through all messages from the SDK
      for await (const message of this.currentQuery) {
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
