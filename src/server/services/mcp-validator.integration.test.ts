import { describe, it, expect } from 'vitest';
import path from 'path';
import type { ResolvedMcpServer } from '@/lib/settings-types';
import { validateMcpServer } from './mcp-validator';

describe('validateMcpServer', () => {
  it('spawns a stdio server with its env and lists its tools', async () => {
    const server: ResolvedMcpServer = {
      name: 'test-stdio',
      type: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', path.join(__dirname, 'mcp-validator.stdio-fixture.mts')],
      env: { FIXTURE_REPLY: 'pong' },
    };

    const result = await validateMcpServer(server);

    expect(result).toEqual({ success: true, tools: ['ping'] });
  }, 20_000);

  it('reports a stdio command that does not exist', async () => {
    const server: ResolvedMcpServer = {
      name: 'test-stdio-missing',
      type: 'stdio',
      command: 'definitely-not-an-installed-command-xyz',
    };

    const result = await validateMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Command not found - check the command and PATH');
  });

  it('should return a friendly error for an unreachable HTTP server', async () => {
    const server: ResolvedMcpServer = {
      name: 'test-http',
      type: 'http',
      url: 'http://localhost:1/nonexistent-mcp-endpoint',
    };

    const result = await validateMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid port in URL');
  });

  it('should return a friendly error for an unreachable SSE server', async () => {
    const server: ResolvedMcpServer = {
      name: 'test-sse',
      type: 'sse',
      url: 'http://localhost:1/nonexistent-sse-endpoint',
    };

    const result = await validateMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid port in URL');
  });

  it('should return a friendly DNS error for a non-existent host', async () => {
    const server: ResolvedMcpServer = {
      name: 'test-dns',
      type: 'http',
      url: 'http://this-host-definitely-does-not-exist-abc123.example.com/mcp',
    };

    const result = await validateMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Server not found - check the URL');
  });
});
