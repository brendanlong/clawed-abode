import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { createTestSession } from '@/test/fixtures';
import { attributeMessage, type BuiltinToolsLevel } from '@/lib/builtin-tools';
import type { SessionToolsPort } from './builtin-mcp';

let mcp: typeof import('./builtin-mcp');

const port = {
  renameSession: vi.fn(async () => {}),
  createSession: vi.fn(async () => ({ id: 'new-id' })),
  stopSession: vi.fn(async () => ({ status: 'stopped' })),
  isTurnActive: vi.fn(() => false),
} satisfies SessionToolsPort;

async function connect(sessionId: string, level: BuiltinToolsLevel) {
  const server = mcp.buildBuiltinMcpServer(sessionId, level);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: 'text'; text: string }[];
  return { text: first?.text ?? '', isError: result.isError === true };
}

describe('built-in MCP server', () => {
  beforeAll(async () => {
    await setupTestDb();
    mcp = await import('./builtin-mcp');
    mcp.initBuiltinMcp(port);
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    vi.clearAllMocks();
  });

  it('offers rename and list at the basic level, and the management tools only at the manage level', async () => {
    const self = await createTestSession();
    const names = async (level: BuiltinToolsLevel) =>
      (await (await connect(self.id, level)).listTools()).tools.map((t) => t.name).sort();

    expect(await names('basic')).toEqual(['list_sessions', 'rename_session']);
    expect(await names('manage')).toEqual([
      'create_session',
      'list_sessions',
      'read_session',
      'rename_session',
      'stop_session',
    ]);
  });

  it('renames the calling session', async () => {
    const self = await createTestSession();
    const client = await connect(self.id, 'basic');

    expect(await call(client, 'rename_session', { name: '  Fix login  ' })).toMatchObject({
      isError: false,
    });
    expect(port.renameSession).toHaveBeenCalledWith(self.id, 'Fix login');
  });

  it('creates a session marked as agent-created, with a labeled initial prompt', async () => {
    const self = await createTestSession({ name: 'Boss', agentName: 'boss-a1b2' });
    const client = await connect(self.id, 'manage');

    await call(client, 'create_session', {
      name: 'Worker',
      prompt: 'do it',
      repoFullName: 'owner/repo',
      branch: 'main',
    });
    expect(port.createSession).toHaveBeenCalledWith({
      name: 'Worker',
      repoFullName: 'owner/repo',
      branch: 'main',
      initialPrompt: attributeMessage(
        { id: self.id, name: 'Boss', agentName: 'boss-a1b2' },
        'do it'
      ),
      createdBySessionId: self.id,
    });
  });

  it('refuses to read or stop itself', async () => {
    const self = await createTestSession();
    const client = await connect(self.id, 'manage');

    expect(await call(client, 'stop_session', { sessionId: self.id })).toMatchObject({
      isError: true,
    });
    expect(await call(client, 'read_session', { sessionId: self.id })).toMatchObject({
      isError: true,
    });
    expect(port.stopSession).not.toHaveBeenCalled();
  });

  it('requires a branch when creating a session for a repository', async () => {
    const self = await createTestSession();
    const client = await connect(self.id, 'manage');

    expect(
      await call(client, 'create_session', { name: 'W', prompt: 'p', repoFullName: 'o/r' })
    ).toMatchObject({ isError: true });
    expect(port.createSession).not.toHaveBeenCalled();
  });

  it('lists non-archived sessions with their SendMessage addresses, marking the caller', async () => {
    const self = await createTestSession({ agentName: 'me-0001' });
    const other = await createTestSession({ agentName: 'other-0002' });
    await createTestSession({ status: 'archived' });
    const client = await connect(self.id, 'basic');

    const { sessions } = JSON.parse((await call(client, 'list_sessions', {})).text) as {
      sessions: { id: string; agentName: string | null; isYou: boolean }[];
    };
    expect(sessions.map((s) => [s.id, s.agentName, s.isYou]).sort()).toEqual(
      [
        [self.id, 'me-0001', true],
        [other.id, 'other-0002', false],
      ].sort()
    );
  });

  it('reads another session as a condensed transcript', async () => {
    const self = await createTestSession();
    const other = await createTestSession({ name: 'Other' });
    await testPrisma.message.createMany({
      data: [
        { type: 'user', content: { type: 'user', content: 'Do the thing' } },
        {
          type: 'assistant',
          content: {
            type: 'assistant',
            parent_tool_use_id: null,
            message: { content: [{ type: 'text', text: 'Done it.' }] },
          },
        },
      ].map((m, sequence) => ({
        sessionId: other.id,
        sequence,
        type: m.type,
        content: JSON.stringify(m.content),
      })),
    });
    const client = await connect(self.id, 'manage');

    const { text, isError } = await call(client, 'read_session', { sessionId: other.id });
    expect(isError).toBe(false);
    expect(text).toContain('"name":"Other"');
    expect(text).toContain('[#0 user] Do the thing');
    expect(text).toContain('[#1 assistant] Done it.');
  });

  it('stops another session, and reports when it was not running', async () => {
    const self = await createTestSession();
    const other = await createTestSession({ name: 'Other' });
    const client = await connect(self.id, 'manage');

    expect(await call(client, 'stop_session', { sessionId: other.id })).toEqual({
      text: 'Stopped "Other".',
      isError: false,
    });
    expect(port.stopSession).toHaveBeenCalledWith(other.id);

    port.stopSession.mockResolvedValueOnce({ status: 'archived' });
    expect(await call(client, 'stop_session', { sessionId: other.id })).toMatchObject({
      isError: true,
      text: expect.stringContaining('archived'),
    });
  });

  it('pages a long transcript newest-first within the output budget', async () => {
    const self = await createTestSession();
    const other = await createTestSession();
    const reply = (n: number) => ({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: `reply ${n} `.padEnd(3000, 'x') }] },
    });
    await testPrisma.message.createMany({
      data: Array.from({ length: 60 }, (_, sequence) => ({
        sessionId: other.id,
        sequence,
        type: 'assistant',
        content: JSON.stringify(reply(sequence)),
      })),
    });
    const client = await connect(self.id, 'manage');
    const read = async (cursor?: number) => {
      const { text } = await call(client, 'read_session', { sessionId: other.id, cursor });
      const newline = text.indexOf('\n');
      const header = JSON.parse(text.slice(0, newline)) as { nextCursor?: number };
      const sequences = [...text.matchAll(/\[#(\d+) assistant\]/g)].map((m) => Number(m[1]));
      return { header, sequences, length: text.length };
    };

    const first = await read();
    expect(first.length).toBeLessThan(45000);
    expect(first.sequences.at(-1)).toBe(59);
    expect(first.header.nextCursor).toBe(first.sequences[0]);

    const seen = [...first.sequences];
    let cursor = first.header.nextCursor;
    while (cursor !== undefined) {
      const page = await read(cursor);
      seen.unshift(...page.sequences);
      cursor = page.header.nextCursor;
    }
    expect(seen).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });
});
