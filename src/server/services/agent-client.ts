/**
 * HTTP client for communicating with the agent service running inside containers.
 *
 * The agent service exposes an HTTP API with endpoints for querying Claude,
 * interrupting queries, checking status, and fetching persisted messages.
 * This client provides a typed interface for all those operations.
 *
 * Uses Unix domain sockets for communication instead of TCP ports.
 */

import http from 'node:http';
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
 * Make an HTTP request over a Unix socket.
 */
function httpRequest(
  socketPath: string,
  options: http.RequestOptions,
  body?: string
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        ...options,
        socketPath,
      },
      (res) => {
        resolve(res);
      }
    );

    req.on('error', reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

/**
 * Helper to read full response body and parse as JSON.
 */
async function readJsonResponse<T>(res: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    res.on('data', (chunk) => {
      body += chunk.toString();
    });
    res.on('end', () => {
      try {
        resolve(JSON.parse(body) as T);
      } catch (err) {
        reject(new Error(`Failed to parse JSON response: ${err}`));
      }
    });
    res.on('error', reject);
  });
}

/**
 * Create an agent client that communicates with the agent service via Unix socket.
 */
export function createAgentClient(socketPath: string): AgentClient {
  async function fetchJson<T>(path: string, method: string = 'GET', body?: unknown): Promise<T> {
    const res = await httpRequest(
      socketPath,
      {
        path,
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      },
      body ? JSON.stringify(body) : undefined
    );

    if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
      const text = await readJsonResponse<{ error?: string }>(res);
      throw new Error(`Agent service error (${res.statusCode}): ${text.error || 'Unknown error'}`);
    }

    return readJsonResponse<T>(res);
  }

  return {
    async *query(options) {
      const res = await httpRequest(
        socketPath,
        {
          path: '/query',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        JSON.stringify({
          prompt: options.prompt,
          sessionId: options.sessionId,
          resume: options.resume ?? false,
          cwd: options.cwd,
          mcpServers: options.mcpServers,
        })
      );

      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        const text = await readJsonResponse<{ error?: string }>(res);
        throw new Error(
          `Agent service query failed (${res.statusCode}): ${text.error || 'Unknown error'}`
        );
      }

      // Parse SSE stream
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        for await (const chunk of res) {
          buffer += decoder.decode(chunk, { stream: true });

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
        res.destroy();
      }
    },

    async interrupt() {
      return fetchJson<{ success: boolean }>('/interrupt', 'POST');
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
 * Get the agent service socket path for a session.
 * Socket is located in the shared sockets volume at /sockets/{sessionId}.sock
 */
export function getAgentSocketPath(sessionId: string): string {
  return `/sockets/${sessionId}.sock`;
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
