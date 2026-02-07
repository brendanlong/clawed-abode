import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentClient, waitForAgentHealth, type AgentClient } from './agent-client';

// Helper to create a mock HTTP server that listens on a Unix socket
function createMockServer(): {
  server: http.Server;
  socketPath: string;
  start: () => Promise<string>;
  close: () => Promise<void>;
  setHandler: (handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) => void;
} {
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => {
    res.writeHead(404);
    res.end();
  };

  const server = http.createServer((req, res) => handler(req, res));
  const socketPath = path.join(os.tmpdir(), `test-socket-${Date.now()}-${Math.random()}.sock`);

  return {
    server,
    socketPath,
    start: () =>
      new Promise<string>((resolve) => {
        // Remove stale socket if it exists
        if (fs.existsSync(socketPath)) {
          fs.unlinkSync(socketPath);
        }
        server.listen(socketPath, () => {
          resolve(socketPath);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          // Clean up socket file
          if (fs.existsSync(socketPath)) {
            fs.unlinkSync(socketPath);
          }
          resolve();
        });
      }),
    setHandler: (h) => {
      handler = h;
    },
  };
}

describe('AgentClient', () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let client: AgentClient;

  beforeEach(async () => {
    mockServer = createMockServer();
    const socketPath = await mockServer.start();
    client = createAgentClient(socketPath);
  });

  afterEach(async () => {
    await mockServer.close();
  });

  describe('health', () => {
    it('should return true when service is healthy', async () => {
      mockServer.setHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });

      expect(await client.health()).toBe(true);
    });

    it('should return false when service is unreachable', async () => {
      await mockServer.close();
      const unreachableClient = createAgentClient('/tmp/nonexistent-socket.sock');
      expect(await unreachableClient.health()).toBe(false);
    });

    it('should return false on non-200 response', async () => {
      mockServer.setHandler((_req, res) => {
        res.writeHead(500);
        res.end('Internal Server Error');
      });

      expect(await client.health()).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should return status information', async () => {
      mockServer.setHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            running: true,
            messageCount: 42,
            lastSequence: 42,
          })
        );
      });

      const status = await client.getStatus();
      expect(status.running).toBe(true);
      expect(status.messageCount).toBe(42);
      expect(status.lastSequence).toBe(42);
    });
  });

  describe('interrupt', () => {
    it('should send interrupt request', async () => {
      mockServer.setHandler((req, res) => {
        expect(req.method).toBe('POST');
        expect(req.url).toBe('/interrupt');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });

      const result = await client.interrupt();
      expect(result.success).toBe(true);
    });
  });

  describe('getMessages', () => {
    it('should fetch messages after sequence', async () => {
      const mockMessages = [
        { sequence: 6, message: { type: 'assistant', uuid: 'a1' } },
        { sequence: 7, message: { type: 'result', uuid: 'r1' } },
      ];

      mockServer.setHandler((req, res) => {
        expect(req.url).toBe('/messages?after=5');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages: mockMessages }));
      });

      const messages = await client.getMessages(5);
      expect(messages).toHaveLength(2);
      expect(messages[0].sequence).toBe(6);
      expect(messages[1].sequence).toBe(7);
    });
  });

  describe('query', () => {
    it('should stream messages from SSE response', async () => {
      mockServer.setHandler((req, res) => {
        expect(req.method).toBe('POST');
        expect(req.url).toBe('/query');

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        // Send two messages then completion
        const msg1 = {
          sequence: 1,
          message: {
            type: 'system',
            subtype: 'init',
            session_id: 'test-session',
          },
        };
        const msg2 = {
          sequence: 2,
          message: {
            type: 'assistant',
            uuid: 'a1',
            session_id: 'test-session',
          },
        };

        res.write(`data: ${JSON.stringify(msg1)}\n\n`);
        res.write(`data: ${JSON.stringify(msg2)}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
      });

      const messages: Array<{ sequence: number }> = [];
      for await (const msg of client.query({
        prompt: 'test',
        sessionId: 'test-session',
      })) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].sequence).toBe(1);
      expect(messages[1].sequence).toBe(2);
    });

    it('should throw on query error event', async () => {
      mockServer.setHandler((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        res.write(`data: ${JSON.stringify({ error: 'Something went wrong' })}\n\n`);
        res.end();
      });

      const messages: unknown[] = [];
      await expect(async () => {
        for await (const msg of client.query({
          prompt: 'test',
          sessionId: 'test-session',
        })) {
          messages.push(msg);
        }
      }).rejects.toThrow('Something went wrong');
    });

    it('should send correct request body', async () => {
      let receivedBody = '';

      mockServer.setHandler((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          receivedBody = body;
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
          });
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          res.end();
        });
      });

      for await (const _msg of client.query({
        prompt: 'hello',
        sessionId: 'sess-123',
        resume: true,
        cwd: '/workspace/repo',
      })) {
        // consume iterator
      }

      const parsed = JSON.parse(receivedBody);
      expect(parsed.prompt).toBe('hello');
      expect(parsed.sessionId).toBe('sess-123');
      expect(parsed.resume).toBe(true);
      expect(parsed.cwd).toBe('/workspace/repo');
    });
  });
});

describe('waitForAgentHealth', () => {
  it('should return true when health check passes', async () => {
    const mockClient: AgentClient = {
      health: vi.fn().mockResolvedValue(true),
      query: vi.fn() as unknown as AgentClient['query'],
      interrupt: vi.fn(),
      getStatus: vi.fn(),
      getMessages: vi.fn(),
    };

    const result = await waitForAgentHealth(mockClient, {
      maxAttempts: 3,
      intervalMs: 10,
    });
    expect(result).toBe(true);
    expect(mockClient.health).toHaveBeenCalledTimes(1);
  });

  it('should retry and eventually succeed', async () => {
    let attempts = 0;
    const mockClient: AgentClient = {
      health: vi.fn().mockImplementation(async () => {
        attempts++;
        return attempts >= 3;
      }),
      query: vi.fn() as unknown as AgentClient['query'],
      interrupt: vi.fn(),
      getStatus: vi.fn(),
      getMessages: vi.fn(),
    };

    const result = await waitForAgentHealth(mockClient, {
      maxAttempts: 5,
      intervalMs: 10,
    });
    expect(result).toBe(true);
    expect(attempts).toBe(3);
  });

  it('should return false after max attempts', async () => {
    const mockClient: AgentClient = {
      health: vi.fn().mockResolvedValue(false),
      query: vi.fn() as unknown as AgentClient['query'],
      interrupt: vi.fn(),
      getStatus: vi.fn(),
      getMessages: vi.fn(),
    };

    const result = await waitForAgentHealth(mockClient, {
      maxAttempts: 3,
      intervalMs: 10,
    });
    expect(result).toBe(false);
    expect(mockClient.health).toHaveBeenCalledTimes(3);
  });
});
