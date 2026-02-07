/**
 * HTTP client for communicating with the agent service running inside containers.
 *
 * The agent service exposes an HTTP API with endpoints for querying Claude,
 * interrupting queries, checking status, and fetching persisted messages.
 * This client provides a typed interface for all those operations.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createLogger, toError } from '@/lib/logger';

const log = createLogger('agent-client');

/**
 * A message received from the agent service, with its sequence number.
 */
export interface AgentMessage {
  sequence: number;
  message: SDKMessage;
}

/**
 * Status response from the agent service.
 */
export interface AgentStatus {
  running: boolean;
  messageCount: number;
  lastSequence: number;
}

/**
 * SSE event from the /query endpoint.
 * Either a message, a completion marker, or an error.
 */
type SSEEvent = { sequence: number; message: SDKMessage } | { done: true } | { error: string };

/**
 * Client for communicating with the agent service running inside a container.
 */
export interface AgentClient {
  /**
   * Start a query and stream results as an async iterable.
   * Each yielded item is an AgentMessage with sequence number and SDK message.
   */
  query(options: {
    prompt: string;
    sessionId: string;
    resume?: boolean;
    cwd?: string;
    mcpServers?: Record<string, unknown>;
  }): AsyncGenerator<AgentMessage>;

  /**
   * Interrupt the currently running query.
   */
  interrupt(): Promise<{ success: boolean }>;

  /**
   * Get the current status of the agent service.
   */
  getStatus(): Promise<AgentStatus>;

  /**
   * Get messages after a given sequence number.
   * Used for catching up after reconnection.
   */
  getMessages(afterSequence: number): Promise<AgentMessage[]>;

  /**
   * Health check - returns true if the agent service is reachable.
   */
  health(): Promise<boolean>;
}

/**
 * Create an agent client that communicates with the agent service at the given URL.
 */
export function createAgentClient(baseUrl: string): AgentClient {
  async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, options);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Agent service error (${response.status}): ${text}`);
    }
    return response.json() as Promise<T>;
  }

  return {
    async *query(options) {
      const response = await fetch(`${baseUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: options.prompt,
          sessionId: options.sessionId,
          resume: options.resume ?? false,
          cwd: options.cwd,
          mcpServers: options.mcpServers,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Agent service query failed (${response.status}): ${text}`);
      }

      if (!response.body) {
        throw new Error('No response body from agent service');
      }

      // Parse SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE events (terminated by \n\n)
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';

          for (const event of events) {
            const lines = event.split('\n');
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;

              const data = line.slice(6); // Remove 'data: ' prefix
              let parsed: SSEEvent;
              try {
                parsed = JSON.parse(data) as SSEEvent;
              } catch {
                log.warn('Failed to parse SSE event', { data: data.slice(0, 100) });
                continue;
              }

              if ('done' in parsed) {
                // Query completed
                return;
              }

              if ('error' in parsed) {
                throw new Error(`Agent query error: ${parsed.error}`);
              }

              if ('sequence' in parsed && 'message' in parsed) {
                yield {
                  sequence: parsed.sequence,
                  message: parsed.message,
                };
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },

    async interrupt() {
      return fetchJson<{ success: boolean }>('/interrupt', {
        method: 'POST',
      });
    },

    async getStatus() {
      return fetchJson<AgentStatus>('/status');
    },

    async getMessages(afterSequence) {
      return fetchJson<{ messages: AgentMessage[] }>(`/messages?after=${afterSequence}`).then(
        (res) => res.messages
      );
    },

    async health() {
      try {
        const result = await fetchJson<{ ok: boolean }>('/health');
        return result.ok === true;
      } catch (err) {
        log.debug('Health check failed', { error: toError(err).message });
        return false;
      }
    },
  };
}

/**
 * Get the agent service URL for a session.
 * For host networking, uses localhost with the session's assigned port.
 * For bridge networking, uses the container's IP with a fixed port.
 */
export function getAgentUrl(agentPort: number): string {
  return `http://localhost:${agentPort}`;
}

/**
 * Wait for the agent service to become healthy, with retries.
 * Returns true if healthy, false if timed out.
 */
export async function waitForAgentHealth(
  client: AgentClient,
  options: {
    maxAttempts?: number;
    intervalMs?: number;
  } = {}
): Promise<boolean> {
  const { maxAttempts = 30, intervalMs = 1000 } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (await client.health()) {
        return true;
      }
    } catch {
      // Expected while service is starting up
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return false;
}
