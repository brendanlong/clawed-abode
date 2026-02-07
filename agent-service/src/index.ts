import http from 'node:http';
import fs from 'node:fs';
import { MessageStore } from './message-store.js';
import { QueryRunner, type QueryOptions } from './query-runner.js';
import type { SDKMessage, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { PartialAssistantMessage } from './stream-accumulator.js';

const SOCKET_PATH = process.env.AGENT_SOCKET_PATH || '/sockets/agent.sock';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || '';

const store = new MessageStore();
const runner = new QueryRunner(store);

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
 * Body: { prompt: string, sessionId: string, resume?: boolean, cwd?: string }
 */
async function handleQuery(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await parseBody(req)) as {
    prompt?: string;
    sessionId?: string;
    resume?: boolean;
    cwd?: string;
    mcpServers?: Record<string, McpServerConfig>;
  };

  if (!body.prompt || typeof body.prompt !== 'string') {
    sendError(res, 400, 'Missing or invalid "prompt" field');
    return;
  }

  if (!body.sessionId || typeof body.sessionId !== 'string') {
    sendError(res, 400, 'Missing or invalid "sessionId" field');
    return;
  }

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

  // Handle client disconnect
  req.on('close', () => {
    unsubscribeMessages();
    unsubscribePartials();
  });

  const options: QueryOptions = {
    prompt: body.prompt,
    sessionId: body.sessionId,
    resume: body.resume ?? false,
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
    const errorStack = err instanceof Error ? err.stack : undefined;
    console.error('Query failed:', errorMessage);
    if (errorStack) {
      console.error('Stack trace:', errorStack);
    }
    res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
  } finally {
    unsubscribeMessages();
    unsubscribePartials();
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
  });
}

/**
 * Handle GET /messages?after=N
 */
function handleMessages(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || '/', `http://unix`);
  const afterParam = url.searchParams.get('after');
  const after = afterParam ? parseInt(afterParam, 10) : 0;

  if (isNaN(after)) {
    sendError(res, 400, 'Invalid "after" parameter');
    return;
  }

  const messages = store.getAfter(after);
  sendJson(res, 200, {
    messages: messages.map((m) => ({
      sequence: m.sequence,
      message: JSON.parse(m.content),
    })),
  });
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
    } else if (method === 'GET' && path === '/health') {
      handleHealth(req, res);
    } else {
      sendError(res, 404, 'Not found');
    }
  } catch (err) {
    console.error('Request error:', err);
    sendError(res, 500, err instanceof Error ? err.message : 'Internal server error');
  }
});

// Remove stale socket file if it exists (handles crashed agents)
if (fs.existsSync(SOCKET_PATH)) {
  console.log(`Removing stale socket file: ${SOCKET_PATH}`);
  fs.unlinkSync(SOCKET_PATH);
}

// Bind to Unix socket
server.listen(SOCKET_PATH, () => {
  // Set socket permissions to allow service container to connect
  fs.chmodSync(SOCKET_PATH, 0o666);
  console.log(`Agent service listening on ${SOCKET_PATH}`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Socket ${SOCKET_PATH} is already in use`);
    // Try to remove and retry once
    try {
      fs.unlinkSync(SOCKET_PATH);
      server.listen(SOCKET_PATH, () => {
        fs.chmodSync(SOCKET_PATH, 0o666);
        console.log(`Agent service listening on ${SOCKET_PATH} (after retry)`);
      });
    } catch (retryErr) {
      console.error('Failed to bind after removing stale socket:', retryErr);
      process.exit(1);
    }
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  server.close(() => {
    // Clean up socket file
    try {
      if (fs.existsSync(SOCKET_PATH)) {
        fs.unlinkSync(SOCKET_PATH);
      }
    } catch (err) {
      console.error('Failed to clean up socket file:', err);
    }
    store.close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  server.close(() => {
    // Clean up socket file
    try {
      if (fs.existsSync(SOCKET_PATH)) {
        fs.unlinkSync(SOCKET_PATH);
      }
    } catch (err) {
      console.error('Failed to clean up socket file:', err);
    }
    store.close();
    process.exit(0);
  });
});
