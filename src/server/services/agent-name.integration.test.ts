import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { createNoRepoSession, createTestSession } from '@/test/fixtures';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));
vi.mock('./settings-merger', () => ({ loadClaudeCredential: async () => 'sk-ant-oat01-test' }));
const { mockEmitSessionUpdate } = vi.hoisted(() => ({ mockEmitSessionUpdate: vi.fn() }));
vi.mock('./events', () => ({ sseEvents: { emitSessionUpdate: mockEmitSessionUpdate } }));
vi.mock('@/lib/logger', async () => (await import('@/test/mock-logger')).mockLoggerModule());

let resolveAgentName: (typeof import('./agent-name'))['resolveAgentName'];

function reply(text: string) {
  return { content: [{ type: 'text', text }] };
}

async function storedAgentName(sessionId: string) {
  const row = await testPrisma.session.findUniqueOrThrow({ where: { id: sessionId } });
  return row.agentName;
}

describe('resolveAgentName', () => {
  beforeAll(async () => {
    await setupTestDb();
    ({ resolveAgentName } = await import('./agent-name'));
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    mockCreate.mockReset();
    mockEmitSessionUpdate.mockReset();
  });

  it('generates a name from the title, repo, and prompt and stores it', async () => {
    mockCreate.mockResolvedValue(reply('Collatz Bound'));
    const session = await createTestSession({ name: 'Prove the bound' });
    const prefix = session.id.replace(/-/g, '').slice(0, 4);

    const name = await resolveAgentName(session.id, 'Prove the Collatz bound');

    expect(name).toBe(`collatz-bound-${prefix}`);
    expect(await storedAgentName(session.id)).toBe(name);
    expect(mockEmitSessionUpdate).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ agentName: name })
    );
    const request = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(request).toContain('Prove the bound');
    expect(request).toContain('Repository: repo');
    expect(request).toContain('Prove the Collatz bound');
  });

  it('keeps a stored name instead of regenerating', async () => {
    const session = await createTestSession({ agentName: 'kept-name-1234' });

    expect(await resolveAgentName(session.id)).toBe('kept-name-1234');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('shares one generation between concurrent calls', async () => {
    mockCreate.mockResolvedValue(reply('shared-name'));
    const session = await createTestSession();

    const [first, second] = await Promise.all([
      resolveAgentName(session.id, 'prompt'),
      resolveAgentName(session.id),
    ]);

    expect(first).toBe(second);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('falls back to the repo name when generation fails', async () => {
    mockCreate.mockRejectedValue(new Error('overloaded'));
    const session = await createTestSession();
    const prefix = session.id.replace(/-/g, '').slice(0, 4);

    expect(await resolveAgentName(session.id)).toBe(`repo-${prefix}`);
  });

  it('keeps the name another writer stored first', async () => {
    mockCreate.mockImplementation(async () => {
      await testPrisma.session.update({
        where: { id: session.id },
        data: { agentName: 'first-1' },
      });
      return reply('second');
    });
    const session = await createTestSession();

    expect(await resolveAgentName(session.id)).toBe('first-1');
  });

  it('falls back to a session id prefix with no usable reply and no repo', async () => {
    mockCreate.mockResolvedValue(reply('!!!'));
    const session = await createNoRepoSession();

    expect(await resolveAgentName(session.id)).toBe(session.id.slice(0, 8));
  });
});
