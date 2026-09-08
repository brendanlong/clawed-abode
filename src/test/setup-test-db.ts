/**
 * Test database setup utilities.
 *
 * Gives each integration test file its own SQLite database, copied from the
 * template that src/test/global-setup-integration.ts migrated once for the run.
 * Uses the real Prisma client and prisma module - no mocking needed.
 *
 * Usage in tests:
 * ```typescript
 * import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
 *
 * beforeAll(async () => {
 *   await setupTestDb();
 * });
 *
 * afterAll(async () => {
 *   await teardownTestDb();
 * });
 *
 * beforeEach(async () => {
 *   await clearTestDb();
 * });
 *
 * // Use testPrisma for direct database access in tests
 * // The routers will use the same database via the real @/lib/prisma import
 * ```
 */

import { resetEnvCache } from '@/lib/env';
import { inject } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { copyFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tempDir: string | null = null;

// Direct reference to the test prisma client for test assertions
export let testPrisma: PrismaClient;

/**
 * Set up a test database.
 *
 * This must be called before any code imports @/lib/prisma,
 * which in practice means calling it in beforeAll at the top of the test file.
 */
export async function setupTestDb(): Promise<void> {
  // Create a temp directory for the SQLite file
  tempDir = mkdtempSync(join(tmpdir(), 'prisma-test-'));
  const dbPath = join(tempDir, 'test.db');
  const databaseUrl = `file:${dbPath}`;

  // Set DATABASE_URL before Prisma client is created
  process.env.DATABASE_URL = databaseUrl;

  // Set required env vars for tests
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token-placeholder';
  process.env.ENCRYPTION_KEY = 'test-encryption-key-for-integration-tests';
  resetEnvCache();

  // Clear any cached Prisma client from globalThis so it recreates with new URL
  const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
  if (globalForPrisma.prisma) {
    await globalForPrisma.prisma.$disconnect();
    globalForPrisma.prisma = undefined;
  }

  copyFileSync(inject('testDbTemplate'), dbPath);

  // Now import the real prisma module - it will create a client with our test DATABASE_URL
  // We use dynamic import to ensure it happens after we set DATABASE_URL
  const { prisma } = await import('@/lib/prisma');
  testPrisma = prisma;

  await testPrisma.$connect();
}

/**
 * Clean up the test database.
 */
export async function teardownTestDb(): Promise<void> {
  if (testPrisma) {
    await testPrisma.$disconnect();
  }

  // Clear the global cache
  const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
  globalForPrisma.prisma = undefined;

  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
}

/**
 * Clear all data from the test database.
 */
export async function clearTestDb(): Promise<void> {
  // Delete in order to respect foreign key constraints
  await testPrisma.message.deleteMany();
  await testPrisma.session.deleteMany();
  await testPrisma.rateLimitWindow.deleteMany();
  await testPrisma.authSession.deleteMany();
  // Settings tables (envVar/mcpServer cover both per-repo and global rows)
  await testPrisma.envVar.deleteMany();
  await testPrisma.mcpOAuth.deleteMany();
  await testPrisma.mcpServer.deleteMany();
  await testPrisma.repoSettings.deleteMany();
  await testPrisma.globalSettings.deleteMany();
}
