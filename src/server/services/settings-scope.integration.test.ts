import { resetEnvCache } from '@/lib/env';
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
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

    it('creates and updates MCP servers, preserving unchanged secrets across types', async () => {
      const scope = await makeScope();
      await scopeModule.upsertMcpServer(scope, {
        name: 'srv',
        type: 'http',
        url: 'https://mcp.example.com/v1',
        authType: 'headers',
        headers: { Authorization: { value: 'Bearer t', isSecret: true } },
      });
      const first = await testPrisma.mcpServer.findFirstOrThrow({
        where: { ...scope, name: 'srv' },
      });

      await scopeModule.upsertMcpServer(scope, {
        name: 'srv',
        type: 'http',
        url: 'https://mcp.example.com/v2',
        authType: 'headers',
        headers: { Authorization: { value: '', isSecret: true } },
      });
      const second = await testPrisma.mcpServer.findFirstOrThrow({
        where: { ...scope, name: 'srv' },
      });
      expect(second.id).toBe(first.id);
      expect(second.url).toBe('https://mcp.example.com/v2');
      expect(second.headers).toBe(first.headers);

      await scopeModule.upsertMcpServer(scope, {
        name: 'srv',
        type: 'stdio',
        command: 'node',
        args: ['s.js'],
        env: { KEY: { value: 'k', isSecret: true } },
      });
      const third = await testPrisma.mcpServer.findFirstOrThrow({
        where: { ...scope, name: 'srv' },
      });
      expect(third).toMatchObject({ type: 'stdio', command: 'node', url: null, headers: null });

      const { mcpServers, envVars } = await scopeModule.listScopeSettings(scope);
      expect(envVars).toEqual([]);
      expect(mcpServers[0]).toMatchObject({
        name: 'srv',
        env: { KEY: { value: '••••••••', isSecret: true } },
      });

      await scopeModule.deleteMcpServer(scope, 'srv');
      expect(await testPrisma.mcpServer.count({ where: scope })).toBe(0);
    });

    describe('when another write lands between reading and writing an MCP server', () => {
      const httpServer = (headers: Record<string, { value: string; isSecret: boolean }>) => ({
        name: 'srv',
        type: 'http' as const,
        url: 'https://mcp.example.com',
        authType: 'headers' as const,
        headers,
      });

      /** Run `concurrentWrite` right after the upsert's next read of the row. */
      function interleaveAfterRead(concurrentWrite: () => Promise<unknown>) {
        const findFirst = testPrisma.mcpServer.findFirst.bind(testPrisma.mcpServer);
        vi.spyOn(testPrisma.mcpServer, 'findFirst').mockImplementationOnce(((
          args: Parameters<typeof findFirst>[0]
        ) =>
          findFirst(args).then(async (row) => {
            await concurrentWrite();
            return row;
          })) as unknown as typeof findFirst);
      }

      afterEach(() => vi.restoreAllMocks());

      it('keeps the concurrently stored secret rather than the one read', async () => {
        const scope = await makeScope();
        await scopeModule.upsertMcpServer(
          scope,
          httpServer({ Authorization: { value: 'old', isSecret: true } })
        );
        interleaveAfterRead(() =>
          scopeModule.upsertMcpServer(
            scope,
            httpServer({ Authorization: { value: 'new', isSecret: true } })
          )
        );

        await scopeModule.upsertMcpServer(
          scope,
          httpServer({
            Authorization: { value: '', isSecret: true },
            X: { value: 'x', isSecret: false },
          })
        );
        const row = await testPrisma.mcpServer.findFirstOrThrow({
          where: { ...scope, name: 'srv' },
        });
        const headers = JSON.parse(row.headers!) as Record<
          string,
          { value: string; isSecret: boolean }
        >;
        expect(crypto.decrypt(headers.Authorization.value)).toBe('new');
        expect(headers.X).toEqual({ value: 'x', isSecret: false });
      });

      it('rejects keeping a secret that was concurrently made plaintext', async () => {
        const scope = await makeScope();
        await scopeModule.upsertMcpServer(
          scope,
          httpServer({ Authorization: { value: 'secret', isSecret: true } })
        );
        const plain = httpServer({ Authorization: { value: 'plain', isSecret: false } });
        interleaveAfterRead(() => scopeModule.upsertMcpServer(scope, plain));

        await expect(
          scopeModule.upsertMcpServer(
            scope,
            httpServer({ Authorization: { value: '', isSecret: true } })
          )
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        const row = await testPrisma.mcpServer.findFirstOrThrow({
          where: { ...scope, name: 'srv' },
        });
        expect(JSON.parse(row.headers!)).toEqual(plain.headers);
      });

      it('updates the row a concurrent create inserted', async () => {
        const scope = await makeScope();
        interleaveAfterRead(() =>
          scopeModule.upsertMcpServer(
            scope,
            httpServer({ A: { value: 'theirs', isSecret: false } })
          )
        );

        await scopeModule.upsertMcpServer(
          scope,
          httpServer({ A: { value: 'ours', isSecret: false } })
        );
        const rows = await testPrisma.mcpServer.findMany({ where: { ...scope, name: 'srv' } });
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0].headers!)).toEqual({ A: { value: 'ours', isSecret: false } });
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
