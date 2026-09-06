/**
 * Minimal stdio MCP server used by mcp-validator.test.ts. Run with
 * `node --import tsx <this file>`; exposes one tool so the validator has
 * something to list.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'fixture', version: '0.0.0' });
server.registerTool('ping', { description: 'replies pong' }, async () => ({
  content: [{ type: 'text', text: process.env.FIXTURE_REPLY ?? 'pong' }],
}));
await server.connect(new StdioServerTransport());
