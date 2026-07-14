import { describe, it, expect, afterAll } from 'vitest';
import { rm, readFile, stat } from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { writeSessionMcpConfig, getSessionMcpConfigPath } from './mcp-config-file';
import { getSessionWorkspacePath } from './worktree-manager';

// The config lives inside the real session workspace (~/worktrees/{sessionId}).
// Use a unique session id per run and tear down its whole workspace afterwards.
const sessionId = `mcp-config-test-${uuid()}`;

afterAll(async () => {
  await rm(getSessionWorkspacePath(sessionId), { recursive: true, force: true });
});

describe('mcp-config-file service', () => {
  it('writes the config as { mcpServers } JSON in the session workspace', async () => {
    const record = {
      secret: {
        type: 'http' as const,
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer super-secret-token' },
      },
    };
    const filePath = await writeSessionMcpConfig(sessionId, record);

    expect(filePath).toBe(getSessionMcpConfigPath(sessionId));
    // The config is a sibling of (not inside) the repo clone.
    expect(path.dirname(filePath)).toBe(getSessionWorkspacePath(sessionId));

    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    expect(parsed).toEqual({ mcpServers: record });
  });

  it('writes the file with mode 0600 so only the owner can read it', async () => {
    const filePath = await writeSessionMcpConfig(sessionId, {
      s: { type: 'sse', url: 'https://example.com/sse', headers: { Authorization: 'Bearer x' } },
    });
    const { mode } = await stat(filePath);
    // Mask to the permission bits; must be exactly rw-------.
    expect(mode & 0o777).toBe(0o600);
  });

  it('overwrites the file (still mode 0600) on a subsequent write', async () => {
    await writeSessionMcpConfig(sessionId, {
      a: { command: 'first', env: { TOKEN: 'one' } },
    });
    const filePath = await writeSessionMcpConfig(sessionId, {
      b: { command: 'second', env: { TOKEN: 'two' } },
    });

    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    expect(parsed).toEqual({ mcpServers: { b: { command: 'second', env: { TOKEN: 'two' } } } });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });
});
