import http from 'node:http';
import fs from 'node:fs';
import { z } from 'zod';
import { MessageStore } from './message-store.js';
import { QueryRunner, type QueryOptions } from './query-runner.js';
import { createLogger, toError } from './logger.js';
import type { SDKMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { PartialAssistantMessage } from './stream-accumulator.js';

const log = createLogger('agent-service');

const SOCKET_PATH = process.env.AGENT_SOCKET_PATH || '/sockets/agent.sock';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || '';

const store = new MessageStore();
const runner = new QueryRunner(store);

// --- Zod Schemas ---

const McpStdioServerConfigSchema = z.object({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const McpSSEServerConfigSchema = z.object({
  type: z.literal('sse'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const McpHttpServerConfigSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const McpServerConfigSchema = z.union([
  McpStdioServerConfigSchema,
  McpSSEServerConfigSchema,
  McpHttpServerConfigSchema,
]);

const QueryRequestSchema = z.object({
  prompt: z.string().min(1).max(1_000_000),
  sessionId: z.string().min(1),
  resume: z.boolean().optional().default(false),
  cwd: z.string().min(1).optional(),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
});

const MessagesQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
});

/**
 * Parse JSON request body from an IncomingMessage.
 */
function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error(`Invalid JSON: ${err}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send a JSON response.
 */
function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Send an error response.
 */
function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/**
 * Handle POST /query
 * Starts a query and streams results via SSE.
 * Body: { prompt: string, sessionId: string, resume?: boolean, cwd?: string, mcpServers?: Record<string, McpServerConfig> }
 */
async function handleQuery(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await parseBody(req);
  const parsed = QueryRequestSchema.safeParse(raw);

  if (!parsed.success) {
    sendError(
      res,
      400,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    );
    return;
  }

  const body = parsed.data;

  if (runner.isRunning) {
    sendError(res, 409, 'A query is already running');
    return;
  }

  // Set up SSE response
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Subscribe to complete messages and send them as SSE events
  const unsubscribeMessages = runner.onMessage((sequence: number, message: SDKMessage) => {
    const data = JSON.stringify({ sequence, message });
    res.write(`data: ${data}\n\n`);
  });

  // Subscribe to partial (streaming) messages for real-time UI updates
  const unsubscribePartials = runner.onPartialMessage((partial: PartialAssistantMessage) => {
    const data = JSON.stringify({ partial });
    res.write(`data: ${data}\n\n`);
  });

  // Subscribe to commands updates and send them as SSE events
  const unsubscribeCommands = runner.onCommands((commands: SlashCommand[]) => {
    const data = JSON.stringify({ commands });
    res.write(`data: ${data}\n\n`);
  });

  // Handle client disconnect
  req.on('close', () => {
    unsubscribeMessages();
    unsubscribePartials();
    unsubscribeCommands();
  });

  const options: QueryOptions = {
    prompt: body.prompt,
    sessionId: body.sessionId,
    resume: body.resume,
    systemPrompt: SYSTEM_PROMPT || undefined,
    model: CLAUDE_MODEL || undefined,
    cwd: body.cwd,
    mcpServers: body.mcpServers,
  };

  try {
    await runner.run(options);
    // Send completion event
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error('Query failed', toError(err));
    res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
  } finally {
    unsubscribeMessages();
    unsubscribePartials();
    unsubscribeCommands();
    res.end();
  }
}

/**
 * Handle POST /interrupt
 */
async function handleInterrupt(
  _req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const success = await runner.interrupt();
  sendJson(res, 200, { success });
}

/**
 * Handle GET /status
 */
function handleStatus(_req: http.IncomingMessage, res: http.ServerResponse): void {
  sendJson(res, 200, {
    running: runner.isRunning,
    messageCount: store.getLastSequence(),
    lastSequence: store.getLastSequence(),
    commands: runner.supportedCommands,
  });
}

/**
 * Handle GET /messages?after=N
 */
function handleMessages(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || '/', `http://unix`);
  const parsed = MessagesQuerySchema.safeParse({
    after: url.searchParams.get('after') ?? undefined,
  });

  if (!parsed.success) {
    sendError(
      res,
      400,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    );
    return;
  }

  const messages = store.getAfter(parsed.data.after);
  sendJson(res, 200, {
    messages: messages.map((m) => ({
      sequence: m.sequence,
      message: JSON.parse(m.content),
    })),
  });
}

/**
 * Handle GET /commands
 * Returns the currently known supported slash commands.
 */
function handleCommands(_req: http.IncomingMessage, res: http.ServerResponse): void {
  sendJson(res, 200, { commands: runner.supportedCommands });
}

/**
 * Handle GET /health
 */
function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
  sendJson(res, 200, { ok: true });
}

/**
 * Main request router.
 */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://unix`);
  const path = url.pathname;
  const method = req.method?.toUpperCase();

  try {
    if (method === 'POST' && path === '/query') {
      await handleQuery(req, res);
    } else if (method === 'POST' && path === '/interrupt') {
      await handleInterrupt(req, res);
    } else if (method === 'GET' && path === '/status') {
      handleStatus(req, res);
    } else if (method === 'GET' && path === '/messages') {
      handleMessages(req, res);
    } else if (method === 'GET' && path === '/commands') {
      handleCommands(req, res);
    } else if (method === 'GET' && path === '/health') {
      handleHealth(req, res);
    } else {
      sendError(res, 404, 'Not found');
    }
  } catch (err) {
    log.error('Request error', toError(err));
    sendError(res, 500, err instanceof Error ? err.message : 'Internal server error');
  }
});

// Remove stale socket file if it exists (handles crashed agents)
if (fs.existsSync(SOCKET_PATH)) {
  log.info('Removing stale socket file', { socketPath: SOCKET_PATH });
  fs.unlinkSync(SOCKET_PATH);
}

// Bind to Unix socket
server.listen(SOCKET_PATH, () => {
  // Set socket permissions to allow service container to connect
  fs.chmodSync(SOCKET_PATH, 0o666);
  log.info('Agent service listening', { socketPath: SOCKET_PATH });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.error('Socket already in use', undefined, { socketPath: SOCKET_PATH });
    // Try to remove and retry once
    try {
      fs.unlinkSync(SOCKET_PATH);
      server.listen(SOCKET_PATH, () => {
        fs.chmodSync(SOCKET_PATH, 0o666);
        log.info('Agent service listening (after retry)', { socketPath: SOCKET_PATH });
      });
    } catch (retryErr) {
      log.error('Failed to bind after removing stale socket', toError(retryErr));
      process.exit(1);
    }
  } else {
    log.error('Server error', err);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log.info('Received SIGTERM, shutting down');
  server.close(() => {
    // Clean up socket file
    try {
      if (fs.existsSync(SOCKET_PATH)) {
        fs.unlinkSync(SOCKET_PATH);
      }
    } catch (err) {
      log.error('Failed to clean up socket file', toError(err));
    }
    store.close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log.info('Received SIGINT, shutting down');
  server.close(() => {
    // Clean up socket file
    try {
      if (fs.existsSync(SOCKET_PATH)) {
        fs.unlinkSync(SOCKET_PATH);
      }
    } catch (err) {
      log.error('Failed to clean up socket file', toError(err));
    }
    store.close();
    process.exit(0);
  });
});
