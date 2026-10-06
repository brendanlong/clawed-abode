import { resetEnvCache } from '@/lib/env';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

vi.mock('@/lib/logger', async () => (await import('@/test/mock-logger')).mockLoggerModule());

let scopeModule: typeof import('./settings-scope');
let crypto: typeof import('@/lib/crypto');

/** The same behavior must hold for global rows (repoSettingsId null) and per-repo rows. */
const scopes = [
  { label: 'global', makeScope: async () => ({ repoSettingsId: null }) },
  {
    label: 'repo',
    makeScope: async () => {
      const row = await testPrisma.repoSettings.create({ data: { repoFullName: 'o/r' } });
      return { repoSettingsId: row.id };
    },
  },
];

describe('settings-scope', () => {
  beforeAll(async () => {
    await setupTestDb();
    scopeModule = await import('./settings-scope');
    crypto = await import('@/lib/crypto');
  });
  afterAll(teardownTestDb);
  beforeEach(clearTestDb);

  describe.each(scopes)('$label scope', ({ makeScope }) => {
    it('creates, updates and encrypts env vars, keeping an unchanged secret', async () => {
      const scope = await makeScope();
      await scopeModule.upsertEnvVar(scope, { name: 'PLAIN', value: 'v1', isSecret: false });
      await scopeModule.upsertEnvVar(scope, { name: 'PLAIN', value: 'v2', isSecret: false });
      await scopeModule.upsertEnvVar(scope, { name: 'SECRET', value: 'shh', isSecret: true });

      const rows = await testPrisma.envVar.findMany({ where: scope, orderBy: { name: 'asc' } });
      expect(rows.map((r) => r.name)).toEqual(['PLAIN', 'SECRET']);
      expect(rows[0].value).toBe('v2');
      expect(rows[1].value).not.toBe('shh');
      expect(crypto.decrypt(rows[1].value)).toBe('shh');

      // Empty secret value = unchanged: the ciphertext stays.
      await scopeModule.upsertEnvVar(scope, { name: 'SECRET', value: '', isSecret: true });
      const kept = await testPrisma.envVar.findFirst({ where: { ...scope, name: 'SECRET' } });
      expect(kept?.value).toBe(rows[1].value);

      expect(await scopeModule.getEnvVarValue(scope, 'SECRET')).toBe('shh');
      expect(await scopeModule.getEnvVarValue(scope, 'PLAIN')).toBe('v2');

      // Only the empty string means unchanged; any other value overwrites.
      await scopeModule.upsertEnvVar(scope, { name: 'SECRET', value: 'shh2', isSecret: true });
      expect(await scopeModule.getEnvVarValue(scope, 'SECRET')).toBe('shh2');
      await expect(scopeModule.getEnvVarValue(scope, 'NOPE')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      await scopeModule.deleteEnvVar(scope, 'PLAIN');
      expect(await testPrisma.envVar.count({ where: scope })).toBe(1);
    });

    it('rejects an empty secret env var with no stored secret to keep', async () => {
      const scope = await makeScope();
      await expect(
        scopeModule.upsertEnvVar(scope, { name: 'NEW', value: '', isSecret: true })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await testPrisma.envVar.count({ where: scope })).toBe(0);

      // Another tab flipped it to plaintext: the stale "unchanged" submit must not blank it.
      await scopeModule.upsertEnvVar(scope, { name: 'FLIP', value: 'plain', isSecret: false });
      await expect(
        scopeModule.upsertEnvVar(scope, { name: 'FLIP', value: '', isSecret: true })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await scopeModule.getEnvVarValue(scope, 'FLIP')).toBe('plain');
    });

    describe('MCP servers', () => {
      const httpServer = (headers: Record<string, { value: string; isSecret: boolean }>) => ({
        name: 'srv',
        type: 'http' as const,
        url: 'https://mcp.example.com',
        authType: 'headers' as const,
        headers,
      });
      const storedValues = (scope: { repoSettingsId: string | null }) =>
        testPrisma.mcpServerValue.findMany({
          where: { mcpServer: { ...scope, name: 'srv' } },
          orderBy: { name: 'asc' },
        });

      it('leaves an unchanged secret row untouched while other values change', async () => {
        const scope = await makeScope();
        await scopeModule.upsertMcpServer(
          scope,
          httpServer({
            Authorization: { value: 'Bearer t', isSecret: true },
            Old: { value: 'o', isSecret: false },
          })
        );
        const [auth] = await storedValues(scope);
        expect(crypto.decrypt(auth.value)).toBe('Bearer t');

        await scopeModule.upsertMcpServer(scope, {
          ...httpServer({
            Authorization: { value: '', isSecret: true },
            New: { value: 'n', isSecret: false },
          }),
          url: 'https://mcp.example.com/v2',
        });
        const values = await storedValues(scope);
        expect(values.map((v) => [v.name, v.value])).toEqual([
          ['Authorization', auth.value],
          ['New', 'n'],
        ]);
        expect(values[0].id).toBe(auth.id);

        const { mcpServers, envVars } = await scopeModule.listScopeSettings(scope);
        expect(envVars).toEqual([]);
        expect(mcpServers).toEqual([
          expect.objectContaining({
            name: 'srv',
            url: 'https://mcp.example.com/v2',
            env: {},
            headers: {
              Authorization: { value: '••••••••', isSecret: true },
              New: { value: 'n', isSecret: false },
            },
          }),
        ]);
      });

      it('replaces headers with env vars when switching to stdio', async () => {
        const scope = await makeScope();
        await scopeModule.upsertMcpServer(
          scope,
          httpServer({ KEY: { value: 'header-secret', isSecret: true } })
        );
        // A same-named header secret can't be "kept" as an env var.
        await expect(
          scopeModule.upsertMcpServer(scope, {
            name: 'srv',
            type: 'stdio',
            command: 'node',
            env: { KEY: { value: '', isSecret: true } },
          })
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

        await scopeModule.upsertMcpServer(scope, {
          name: 'srv',
          type: 'stdio',
          command: 'node',
          args: ['s.js'],
          env: { KEY: { value: 'k', isSecret: true } },
        });
        const server = await testPrisma.mcpServer.findFirstOrThrow({
          where: { ...scope, name: 'srv' },
        });
        expect(server).toMatchObject({ type: 'stdio', command: 'node', url: null });
        const values = await storedValues(scope);
        expect(values.map((v) => [v.kind, v.name])).toEqual([['env', 'KEY']]);
        expect(crypto.decrypt(values[0].value)).toBe('k');

        await scopeModule.deleteMcpServer(scope, 'srv');
        expect(await testPrisma.mcpServer.count({ where: scope })).toBe(0);
        expect(await testPrisma.mcpServerValue.count()).toBe(0);
      });

      it('rejects an empty secret with no stored secret to keep, writing nothing', async () => {
        const scope = await makeScope();
        await expect(
          scopeModule.upsertMcpServer(scope, httpServer({ A: { value: '', isSecret: true } }))
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(await testPrisma.mcpServer.count({ where: scope })).toBe(0);

        // Another tab flipped it to plaintext: the stale "unchanged" submit must not blank it.
        const plain = httpServer({ A: { value: 'plain', isSecret: false } });
        await scopeModule.upsertMcpServer(scope, plain);
        await expect(
          scopeModule.upsertMcpServer(scope, {
            ...httpServer({ A: { value: '', isSecret: true } }),
            url: 'https://elsewhere.example.com',
          })
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        const { mcpServers } = await scopeModule.listScopeSettings(scope);
        expect(mcpServers[0]).toMatchObject({ url: plain.url, headers: plain.headers });
      });
    });

    it('upserts the same name concurrently without a unique violation or duplicate rows', async () => {
      const scope = await makeScope();
      await Promise.all(
        ['a', 'b', 'c'].map((value) =>
          scopeModule.upsertEnvVar(scope, { name: 'RACE', value, isSecret: false })
        )
      );
      expect(await testPrisma.envVar.count({ where: { ...scope, name: 'RACE' } })).toBe(1);
    });

    it('keeps createdAt and bumps updatedAt on conflict', async () => {
      const scope = await makeScope();
      await scopeModule.upsertEnvVar(scope, { name: 'T', value: '1', isSecret: false });
      const first = await testPrisma.envVar.findFirstOrThrow({ where: { ...scope, name: 'T' } });
      await new Promise((r) => setTimeout(r, 5));
      await scopeModule.upsertEnvVar(scope, { name: 'T', value: '2', isSecret: false });
      const second = await testPrisma.envVar.findFirstOrThrow({ where: { ...scope, name: 'T' } });
      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
      expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
    });

    it('refuses to store secrets without an encryption key', async () => {
      const scope = await makeScope();
      const saved = process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;
      resetEnvCache();
      try {
        await expect(
          scopeModule.upsertEnvVar(scope, { name: 'S', value: 'x', isSecret: true })
        ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      } finally {
        process.env.ENCRYPTION_KEY = saved;
        resetEnvCache();
      }
    });
  });

  it('keeps global and per-repo entries with the same name apart', async () => {
    const repo = await scopes[1].makeScope();
    await scopeModule.upsertEnvVar(
      { repoSettingsId: null },
      { name: 'X', value: 'global', isSecret: false }
    );
    await scopeModule.upsertEnvVar(repo, { name: 'X', value: 'repo', isSecret: false });
    expect(await scopeModule.getEnvVarValue({ repoSettingsId: null }, 'X')).toBe('global');
    expect(await scopeModule.getEnvVarValue(repo, 'X')).toBe('repo');
  });
});
