import { describe, it, expect } from 'vitest';
import type { ContainerMcpServer } from './repo-settings';
import { validateMcpServer } from './mcp-validator';

describe('validateMcpServer', () => {
  it('should return an informational message for stdio servers', async () => {
    const server: ContainerMcpServer = {
      name: 'test-stdio',
      type: 'stdio',
      command: 'npx',
      args: ['@anthropic/mcp-server-memory'],
    };

    const result = await validateMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Stdio servers run inside session containers');
    expect(result.error).toContain('cannot be validated from the host');
  });

  it('should return a friendly error for an unreachable HTTP server', async () => {
    const server: ContainerMcpServer = {
      name: 'test-http',
      type: 'http',
      url: 'http://localhost:1/nonexistent-mcp-endpoint',
    };

    const result = await validateMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid port in URL');
  });

  it('should return a friendly error for an unreachable SSE server', async () => {
    const server: ContainerMcpServer = {
      name: 'test-sse',
      type: 'sse',
      url: 'http://localhost:1/nonexistent-sse-endpoint',
    };

    const result = await validateMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid port in URL');
  });

  it('should return a friendly DNS error for a non-existent host', async () => {
    const server: ContainerMcpServer = {
      name: 'test-dns',
      type: 'http',
      url: 'http://this-host-definitely-does-not-exist-abc123.example.com/mcp',
    };

    const result = await validateMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Server not found - check the URL');
  });
});
