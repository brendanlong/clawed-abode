import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { testPrisma } from '@/test/setup-test-db';

/**
 * Re-run a migration's backfill against the test database: the SQL from its
 * `-- Backfill` comment up to the next `-- CreateIndex` (or the end). Lets a
 * test check that a backfill restating live logic in SQL agrees with it.
 */
export async function runMigrationBackfill(migrationSuffix: string): Promise<void> {
  const migrationsDir = join(process.cwd(), 'prisma/migrations');
  const migration = readdirSync(migrationsDir).find((d) => d.endsWith(migrationSuffix));
  if (!migration) throw new Error(`No migration ending in ${migrationSuffix}`);
  const sql = readFileSync(join(migrationsDir, migration, 'migration.sql'), 'utf8');
  const start = sql.indexOf('-- Backfill');
  if (start === -1) throw new Error(`${migration} has no -- Backfill section`);
  const end = sql.indexOf('-- CreateIndex', start);
  await testPrisma.$executeRawUnsafe(sql.slice(start, end === -1 ? undefined : end));
}
