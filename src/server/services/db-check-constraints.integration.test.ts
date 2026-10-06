import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@/generated/prisma/client';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { createTestSession } from '@/test/fixtures';
import {
  mcpAuthTypeSchema,
  mcpServerTypeSchema,
  mcpServerValueKindSchema,
} from '@/lib/settings-types';

const MIGRATION = '20261007000000_enforce_stored_invariants_with_checks';
const CHECK_FAILED = /CHECK constraint failed/;

type ExecRaw = (query: string, ...values: unknown[]) => Promise<number>;

function insertMcpServer(
  exec: ExecRaw,
  row: { id: string; type: string; authType?: string; args?: string | null; url?: string | null }
) {
  return exec(
    `INSERT INTO "McpServer" ("id", "name", "type", "command", "args", "url", "authType", "updatedAt")
     VALUES (?, ?, ?, '', ?, ?, ?, CURRENT_TIMESTAMP)`,
    row.id,
    row.id,
    row.type,
    row.args ?? null,
    row.url ?? null,
    row.authType ?? 'headers'
  );
}

function insertMcpServerValue(exec: ExecRaw, id: string, mcpServerId: string, kind: string) {
  return exec(
    `INSERT INTO "McpServerValue" ("id", "mcpServerId", "kind", "name", "value", "updatedAt")
     VALUES (?, ?, ?, ?, 'v', CURRENT_TIMESTAMP)`,
    id,
    mcpServerId,
    kind,
    id
  );
}

describe('database CHECK constraints', () => {
  let exec: ExecRaw;

  beforeAll(async () => {
    await setupTestDb();
    exec = (query, ...values) => testPrisma.$executeRawUnsafe(query, ...values);
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  describe('McpServer', () => {
    it('accepts every type and auth type the Zod schemas allow', async () => {
      for (const type of mcpServerTypeSchema.options) {
        for (const authType of mcpAuthTypeSchema.options) {
          await insertMcpServer(exec, {
            id: `${type}-${authType}`,
            type,
            authType,
            url: type === 'stdio' ? null : 'https://example.com/mcp',
          });
        }
      }
      expect(await testPrisma.mcpServer.count()).toBe(
        mcpServerTypeSchema.options.length * mcpAuthTypeSchema.options.length
      );
    });

    it('rejects a type or auth type outside the Zod schemas', async () => {
      await expect(insertMcpServer(exec, { id: 'a', type: 'ftp' })).rejects.toThrow(CHECK_FAILED);
      await expect(
        insertMcpServer(exec, { id: 'b', type: 'stdio', authType: 'basic' })
      ).rejects.toThrow(CHECK_FAILED);
    });

    it('accepts null or a JSON array for args and rejects anything else', async () => {
      await insertMcpServer(exec, { id: 'null', type: 'stdio', args: null });
      await insertMcpServer(exec, { id: 'array', type: 'stdio', args: '["-y", "pkg"]' });
      for (const args of ['not json', '{}', '"x"', 'null']) {
        await expect(insertMcpServer(exec, { id: args, type: 'stdio', args })).rejects.toThrow(
          CHECK_FAILED
        );
      }
    });

    it('requires a non-empty url for http and sse but not stdio', async () => {
      await insertMcpServer(exec, { id: 'stdio', type: 'stdio', url: null });
      for (const type of ['http', 'sse']) {
        for (const url of [null, '']) {
          await expect(insertMcpServer(exec, { id: `${type}-${url}`, type, url })).rejects.toThrow(
            CHECK_FAILED
          );
        }
      }
    });

    it('keeps the hand-written partial unique index on global names', async () => {
      await insertMcpServer(exec, { id: 'a', type: 'stdio' });
      await expect(
        exec(
          `INSERT INTO "McpServer" ("id", "name", "updatedAt") VALUES ('b', 'a', CURRENT_TIMESTAMP)`
        )
      ).rejects.toThrow(/UNIQUE constraint failed/);
    });

    it('applies on update too', async () => {
      await insertMcpServer(exec, { id: 's', type: 'http', url: 'https://example.com/mcp' });
      await expect(exec(`UPDATE "McpServer" SET "url" = NULL WHERE "id" = 's'`)).rejects.toThrow(
        CHECK_FAILED
      );
    });
  });

  it('McpServerValue.kind accepts exactly the Zod kinds', async () => {
    await insertMcpServer(exec, { id: 's', type: 'stdio' });
    for (const kind of mcpServerValueKindSchema.options) {
      await insertMcpServerValue(exec, kind, 's', kind);
    }
    await expect(insertMcpServerValue(exec, 'cookie', 's', 'cookie')).rejects.toThrow(CHECK_FAILED);
  });

  it('QueuedPrompt.attachments must be a JSON array', async () => {
    const session = await createTestSession();
    const insert = (position: number, attachments: string) =>
      exec(
        `INSERT INTO "QueuedPrompt" ("id", "sessionId", "position", "messageId", "content", "text", "attachments")
         VALUES (?, ?, ?, 'm', 'c', 't', ?)`,
        `q${position}`,
        session.id,
        position,
        attachments
      );
    await insert(0, '["a.png"]');
    await expect(insert(1, 'not json')).rejects.toThrow(CHECK_FAILED);
    await expect(insert(2, '{}')).rejects.toThrow(CHECK_FAILED);
  });

  it('SessionUsage.contextWindows must be a JSON object', async () => {
    const insert = async (contextWindows: string) => {
      const session = await createTestSession();
      return exec(
        `INSERT INTO "SessionUsage" ("sessionId", "contextWindows") VALUES (?, ?)`,
        session.id,
        contextWindows
      );
    };
    await insert('{"m": 200000}');
    await expect(insert('not json')).rejects.toThrow(CHECK_FAILED);
    await expect(insert('[]')).rejects.toThrow(CHECK_FAILED);
  });
});

describe(`migration ${MIGRATION}`, () => {
  const migrationsDir = join(process.cwd(), 'prisma/migrations');
  let dir: string;
  let client: PrismaClient;
  let deploy: () => void;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-constraints-migration-'));
    const dbUrl = `file:${join(dir, 'test.db')}`;
    const tempMigrations = join(dir, 'migrations');
    for (const entry of readdirSync(migrationsDir)) {
      if (entry < MIGRATION)
        cpSync(join(migrationsDir, entry), join(tempMigrations, entry), { recursive: true });
    }
    // Run Prisma's own migrate runner (not raw SQL) against the temp migrations dir.
    const config = join(dir, 'prisma.config.mjs');
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        schema: join(process.cwd(), 'prisma/schema.prisma'),
        migrations: { path: tempMigrations },
        datasource: { url: dbUrl },
      })};\n`
    );
    deploy = () =>
      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--config', config], {
        stdio: 'pipe',
      });
    deploy();
    cpSync(join(migrationsDir, MIGRATION), join(tempMigrations, MIGRATION), { recursive: true });
    client = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });
  }, 120_000);

  afterAll(async () => {
    await client.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('deletes corrupt MCP servers with their children, keeps valid ones, and resets corrupt JSON', async () => {
    const exec: ExecRaw = (query, ...values) => client.$executeRawUnsafe(query, ...values);
    await insertMcpServer(exec, { id: 'stdio-ok', type: 'stdio', args: '["a"]' });
    await insertMcpServer(exec, {
      id: 'http-ok',
      type: 'http',
      authType: 'oauth',
      url: 'https://example.com/mcp',
    });
    await insertMcpServer(exec, { id: 'bad-type', type: 'ftp', url: 'https://example.com' });
    await insertMcpServer(exec, { id: 'bad-args', type: 'stdio', args: 'not json' });
    await insertMcpServer(exec, { id: 'bad-url', type: 'sse', url: null });
    await insertMcpServer(exec, {
      id: 'bad-auth',
      type: 'http',
      authType: 'basic',
      url: 'https://example.com',
    });
    await insertMcpServerValue(exec, 'v-stdio', 'stdio-ok', 'env');
    await insertMcpServerValue(exec, 'v-http', 'http-ok', 'header');
    await insertMcpServerValue(exec, 'v-bad-parent', 'bad-type', 'header');
    await insertMcpServerValue(exec, 'v-bad-kind', 'stdio-ok', 'cookie');
    for (const [id, mcpServerId] of [
      ['o-ok', 'http-ok'],
      ['o-bad', 'bad-auth'],
    ]) {
      await exec(
        `INSERT INTO "McpOAuth" ("id", "mcpServerId", "updatedAt") VALUES (?, ?, CURRENT_TIMESTAMP)`,
        id,
        mcpServerId
      );
    }
    await exec(
      `INSERT INTO "Session" ("id", "name", "updatedAt") VALUES ('s', 's', CURRENT_TIMESTAMP)`
    );
    await exec(
      `INSERT INTO "QueuedPrompt" ("id", "sessionId", "position", "messageId", "content", "text", "attachments")
         VALUES ('q-ok', 's', 0, 'm', 'c', 't', '["a.png"]'), ('q-bad', 's', 1, 'm', 'c', 't', 'oops')`
    );
    await exec(
      `INSERT INTO "SessionUsage" ("sessionId", "resultCount", "contextWindows") VALUES ('s', 3, 'oops')`
    );

    deploy();

    // Raw SQL on the columns that exist as of this migration, so a later migration
    // adding columns to these tables doesn't break the test.
    const rows = (query: string) => client.$queryRawUnsafe<unknown[]>(query);
    expect(await rows(`SELECT "id" FROM "McpServer" ORDER BY "id"`)).toEqual([
      { id: 'http-ok' },
      { id: 'stdio-ok' },
    ]);
    expect(await rows(`SELECT "id", "mcpServerId" FROM "McpServerValue" ORDER BY "id"`)).toEqual([
      { id: 'v-http', mcpServerId: 'http-ok' },
      { id: 'v-stdio', mcpServerId: 'stdio-ok' },
    ]);
    expect(await rows(`SELECT "id", "mcpServerId" FROM "McpOAuth"`)).toEqual([
      { id: 'o-ok', mcpServerId: 'http-ok' },
    ]);
    expect(
      await rows(`SELECT "id", "attachments" FROM "QueuedPrompt" ORDER BY "position"`)
    ).toEqual([
      { id: 'q-ok', attachments: '["a.png"]' },
      { id: 'q-bad', attachments: '[]' },
    ]);
    expect(await rows(`SELECT "resultCount", "contextWindows" FROM "SessionUsage"`)).toEqual([
      { resultCount: 3, contextWindows: '{}' },
    ]);

    expect(await rows('PRAGMA foreign_key_check')).toEqual([]);
    // The children's foreign keys still point at the rebuilt table, so deletes cascade.
    await exec(`DELETE FROM "McpServer" WHERE "id" = 'http-ok'`);
    expect(await rows(`SELECT "id" FROM "McpServerValue"`)).toEqual([{ id: 'v-stdio' }]);
    expect(await rows(`SELECT "id" FROM "McpOAuth"`)).toEqual([]);
  }, 120_000);
});
