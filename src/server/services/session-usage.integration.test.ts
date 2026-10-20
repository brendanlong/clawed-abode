import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { createTestSession } from '@/test/fixtures';
import { EMPTY_SESSION_USAGE_TOTALS } from '@/lib/token-estimation';

let getSessionUsageTotals: (typeof import('./session-usage'))['getSessionUsageTotals'];
let messageUsageStatement: (typeof import('./session-usage'))['messageUsageStatement'];
let parseSessionUsageRow: (typeof import('./session-usage'))['parseSessionUsageRow'];

type TestMessage = { type: 'system' | 'user' | 'assistant' | 'result'; content: unknown };

const result = (fields: Record<string, unknown>): TestMessage => ({
  type: 'result',
  content: { type: 'result', ...fields },
});
const init = (model: string): TestMessage => ({
  type: 'system',
  content: { type: 'system', subtype: 'init', model },
});
const assistant = (
  usage: Record<string, number>,
  { model, parent = null }: { model?: string; parent?: string | null } = {}
): TestMessage => ({
  type: 'assistant',
  content: { type: 'assistant', parent_tool_use_id: parent, message: { model, usage } },
});

/** Run a migration's backfill (everything from its `-- Backfill` comment on). */
async function runBackfill(migrationSuffix: string) {
  const migrationsDir = join(process.cwd(), 'prisma/migrations');
  const migration = readdirSync(migrationsDir).find((d) => d.endsWith(migrationSuffix));
  const sql = readFileSync(join(migrationsDir, migration!, 'migration.sql'), 'utf8');
  await testPrisma.$executeRawUnsafe(sql.slice(sql.indexOf('-- Backfill')));
}

async function record(sessionId: string, messages: TestMessage[]) {
  for (const m of messages) {
    await messageUsageStatement(sessionId, m.type, m.content);
  }
}

describe('session-usage', () => {
  beforeAll(async () => {
    await setupTestDb();
    // After setupTestDb, so @/lib/prisma binds to the test database.
    ({ getSessionUsageTotals, messageUsageStatement, parseSessionUsageRow } =
      await import('./session-usage'));
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  it('should return empty totals for a session with no usage', async () => {
    const session = await createTestSession();
    expect(await getSessionUsageTotals(session.id)).toEqual(EMPTY_SESSION_USAGE_TOTALS);
  });

  it('should sum per-turn result usage', async () => {
    const session = await createTestSession();
    await record(session.id, [
      result({
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
      }),
      result({ usage: { input_tokens: 2000, output_tokens: 800 } }),
      result({}),
    ]);

    expect(await getSessionUsageTotals(session.id)).toMatchObject({
      resultCount: 3,
      inputTokens: 3000,
      outputTokens: 1300,
      cacheReadTokens: 100,
      cacheCreationTokens: 50,
    });
  });

  it('should not overflow 32-bit token counts', async () => {
    const session = await createTestSession();
    await record(session.id, [
      result({ usage: { cache_read_input_tokens: 2_000_000_000 } }),
      result({ usage: { cache_read_input_tokens: 2_000_000_000 } }),
    ]);

    expect((await getSessionUsageTotals(session.id)).cacheReadTokens).toBe(4_000_000_000);
  });

  it.each([
    { name: 'cumulative within one process', costs: [0.05, 0.15, 0.35], total: 0.35 },
    { name: 'one reset', costs: [0.3, 0.5, 0.1, 0.2], total: 0.7 },
    { name: 'multiple resets', costs: [1.0, 0.4, 0.9, 0.25], total: 2.15 },
    { name: 'an equal cost (not a reset)', costs: [0.5, 0.5], total: 0.5 },
    { name: 'a result without a cost', costs: [0.3, undefined, 0.4], total: 0.4 },
  ])('should aggregate total_cost_usd: $name', async ({ costs, total }) => {
    const session = await createTestSession();
    await record(
      session.id,
      costs.map((cost) => result({ total_cost_usd: cost }))
    );

    const totals = await getSessionUsageTotals(session.id);
    expect(totals.closedSegmentsCostUsd + totals.currentSegmentCostUsd).toBeCloseTo(total, 6);
  });

  it('should keep the latest context window per model', async () => {
    const session = await createTestSession();
    await record(session.id, [
      result({ modelUsage: { a: { contextWindow: 200_000 }, b: { contextWindow: 100_000 } } }),
      result({ modelUsage: { a: { contextWindow: 1_000_000 } } }),
    ]);

    expect((await getSessionUsageTotals(session.id)).contextWindowByModel).toEqual({
      a: 1_000_000,
      b: 100_000,
    });
  });

  it('should return the updated totals from each fold', async () => {
    const session = await createTestSession();
    const rows = await messageUsageStatement(session.id, 'result', {
      type: 'result',
      usage: { input_tokens: 7 },
    });
    expect(parseSessionUsageRow(rows?.[0])).toEqual(await getSessionUsageTotals(session.id));
    expect((await getSessionUsageTotals(session.id)).inputTokens).toBe(7);
  });

  it('should keep the latest top-level assistant call, ignoring subagents', async () => {
    const session = await createTestSession();
    await record(session.id, [
      assistant({ input_tokens: 1, output_tokens: 2 }, { model: 'claude-opus-4-5' }),
      assistant(
        { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 },
        { model: 'claude-sonnet-4-6' }
      ),
      assistant({ input_tokens: 999 }, { parent: 'toolu_1', model: 'claude-haiku-4-5' }),
    ]);

    expect((await getSessionUsageTotals(session.id)).lastCall).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 0,
      model: 'claude-sonnet-4-6',
    });
  });

  it('should keep the first init model and ignore other messages', async () => {
    const session = await createTestSession();
    await record(session.id, [
      { type: 'user', content: { type: 'user', message: 'hi' } },
      { type: 'system', content: { type: 'system', subtype: 'error' } },
      init('claude-opus-4-5'),
      init('claude-sonnet-4-6'),
      assistant({ input_tokens: 5 }, { parent: 'toolu_1' }),
    ]);

    expect(await getSessionUsageTotals(session.id)).toEqual({
      ...EMPTY_SESSION_USAGE_TOTALS,
      model: 'claude-opus-4-5',
    });
  });

  it('should backfill existing messages exactly as the live fold does', async () => {
    const messages: TestMessage[] = [
      { type: 'user', content: { type: 'user', message: 'hi' } },
      init('claude-opus-4-5'),
      result({
        total_cost_usd: 0.3,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7 },
        modelUsage: { a: { contextWindow: 200_000 }, b: { inputTokens: 3 } },
      }),
      result({ total_cost_usd: 0.5, usage: { input_tokens: 20, cache_creation_input_tokens: 2 } }),
      init('claude-sonnet-4-6'),
      result({ total_cost_usd: 0.1, modelUsage: { a: { contextWindow: 1_000_000 } } }),
      result({ usage: { output_tokens: 9 } }),
      result({ total_cost_usd: 0.2 }),
    ];
    const live = await createTestSession();
    const backfilled = await createTestSession();
    const initOnly = await createTestSession();
    await record(live.id, messages);
    await testPrisma.message.createMany({
      data: [
        ...messages.map((m, sequence) => ({
          sessionId: backfilled.id,
          sequence,
          type: m.type,
          content: JSON.stringify(m.content),
        })),
        {
          sessionId: initOnly.id,
          sequence: 0,
          type: 'system',
          content: JSON.stringify(init('claude-haiku-4-5').content),
        },
      ],
    });

    await runBackfill('_add_session_usage');

    const expected = await getSessionUsageTotals(live.id);
    expect(expected.closedSegmentsCostUsd + expected.currentSegmentCostUsd).toBeCloseTo(0.7, 6);
    expect(await getSessionUsageTotals(backfilled.id)).toEqual(expected);
    expect(await getSessionUsageTotals(initOnly.id)).toEqual({
      ...EMPTY_SESSION_USAGE_TOTALS,
      model: 'claude-haiku-4-5',
    });
  });

  it('should backfill the latest top-level assistant call exactly as the live fold does', async () => {
    const messages: TestMessage[] = [
      init('claude-opus-4-5'),
      assistant({ input_tokens: 1, output_tokens: 2 }, { model: 'claude-opus-4-5' }),
      result({ usage: { input_tokens: 1 } }),
      assistant(
        { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 4 },
        { model: 'claude-sonnet-4-6' }
      ),
      assistant({ input_tokens: 999 }, { parent: 'toolu_1' }),
      { type: 'assistant', content: { type: 'assistant', message: {} } },
    ];
    const live = await createTestSession();
    const backfilled = await createTestSession();
    const subagentOnly = await createTestSession();
    await record(live.id, messages);
    // The earlier backfill already ran for this session; this one fills in lastCall.
    await record(
      backfilled.id,
      messages.filter((m) => m.type !== 'assistant')
    );
    await testPrisma.message.createMany({
      data: [
        ...messages.map((m, sequence) => ({
          sessionId: backfilled.id,
          sequence,
          type: m.type,
          content: JSON.stringify(m.content),
        })),
        {
          sessionId: subagentOnly.id,
          sequence: 0,
          type: 'assistant',
          content: JSON.stringify(assistant({ input_tokens: 5 }, { parent: 'toolu_1' }).content),
        },
      ],
    });

    await runBackfill('_session_usage_last_call');

    const expected = await getSessionUsageTotals(live.id);
    expect(expected.lastCall).toMatchObject({ inputTokens: 10, model: 'claude-sonnet-4-6' });
    expect(await getSessionUsageTotals(backfilled.id)).toEqual(expected);
    expect(await getSessionUsageTotals(subagentOnly.id)).toEqual(EMPTY_SESSION_USAGE_TOTALS);
  });
});
