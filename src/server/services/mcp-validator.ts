import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createLogger } from '@/lib/logger';
import type { ContainerMcpServer } from './repo-settings';

const log = createLogger('mcp-validator');

const VALIDATION_TIMEOUT_MS = 15_000;

export interface McpValidationResult {
  success: boolean;
  error?: string;
  tools?: string[];
}

function buildHeaders(headers?: Record<string, string>): Record<string, string> {
  return headers && Object.keys(headers).length > 0 ? headers : {};
}

async function connectAndListTools(transport: Transport): Promise<McpValidationResult> {
  const client = new Client({ name: 'clawed-abode-validator', version: '1.0.0' });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return {
      success: true,
      tools: tools.map((t) => t.name),
    };
  } finally {
    try {
      await client.close();
    } catch {
      // Ignore close errors
    }
  }
}

function createStreamableHttpTransport(
  url: string,
  headers: Record<string, string>
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit:
      Object.keys(headers).length > 0
        ? { headers, signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS) }
        : { signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS) },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
}

function createSseTransport(url: string, headers: Record<string, string>): SSEClientTransport {
  return new SSEClientTransport(new URL(url), {
    requestInit:
      Object.keys(headers).length > 0
        ? { headers, signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS) }
        : { signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS) },
    eventSourceInit:
      Object.keys(headers).length > 0
        ? {
            fetch: (input: string | URL | Request, init?: RequestInit) =>
              fetch(input, {
                ...init,
                headers: {
                  ...Object.fromEntries(new Headers(init?.headers).entries()),
                  ...headers,
                },
              }),
          }
        : undefined,
  });
}

async function validateHttpServer(
  url: string,
  headers: Record<string, string>
): Promise<McpValidationResult> {
  // Try Streamable HTTP first, fall back to SSE
  try {
    const transport = createStreamableHttpTransport(url, headers);
    return await connectAndListTools(transport);
  } catch (httpError) {
    log.info('Streamable HTTP failed, falling back to SSE', {
      url,
      error: httpError instanceof Error ? httpError.message : String(httpError),
    });

    try {
      const sseTransport = createSseTransport(url, headers);
      return await connectAndListTools(sseTransport);
    } catch (sseError) {
      // Both failed - report the SSE error since HTTP already failed
      throw sseError;
    }
  }
}

async function validateSseServer(
  url: string,
  headers: Record<string, string>
): Promise<McpValidationResult> {
  const transport = createSseTransport(url, headers);
  return await connectAndListTools(transport);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return `Connection timed out after ${VALIDATION_TIMEOUT_MS / 1000} seconds`;
    }
    // Check the full message chain (SSE SDK wraps errors with prefixes)
    const msg = error.message;
    if (msg.includes('ECONNREFUSED')) {
      return 'Connection refused - is the server running?';
    }
    if (msg.includes('ENOTFOUND')) {
      return 'Server not found - check the URL';
    }
    if (msg.includes('ECONNRESET')) {
      return 'Connection reset by server';
    }
    if (msg.includes('bad port')) {
      return 'Invalid port in URL';
    }
    if (msg.includes('401') || msg.includes('Unauthorized')) {
      return 'Authentication failed (401) - check your headers/credentials';
    }
    if (msg.includes('403') || msg.includes('Forbidden')) {
      return 'Access denied (403) - check your permissions';
    }
    if (msg.includes('404') || msg.includes('Not Found')) {
      return 'Endpoint not found (404) - check the URL path';
    }
    // Strip SDK wrapper prefixes for cleaner messages
    const cleaned = msg
      .replace(/^SSE error:\s*/i, '')
      .replace(/^TypeError:\s*/i, '')
      .replace(/^fetch failed:\s*/i, '');
    return cleaned || msg;
  }
  return String(error);
}

export async function validateMcpServer(server: ContainerMcpServer): Promise<McpValidationResult> {
  if (server.type === 'stdio') {
    return {
      success: false,
      error:
        'Stdio servers run inside session containers and cannot be validated from the host. They will be tested when a session starts.',
    };
  }

  const headers = buildHeaders(server.headers);

  try {
    if (server.type === 'http') {
      return await validateHttpServer(server.url, headers);
    }

    // SSE
    return await validateSseServer(server.url, headers);
  } catch (error) {
    log.warn('MCP server validation failed', {
      name: server.name,
      type: server.type,
      url: server.url,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      error: formatError(error),
    };
  }
}
