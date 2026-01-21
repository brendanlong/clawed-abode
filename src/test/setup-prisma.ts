/**
 * Test utilities for setting up an in-memory SQLite database with Prisma.
 *
 * Usage in tests:
 * ```typescript
 * import { setupTestDatabase, teardownTestDatabase, getTestPrisma } from '@/test/setup-prisma';
 *
 * beforeAll(async () => {
 *   await setupTestDatabase();
 * });
 *
 * afterAll(async () => {
 *   await teardownTestDatabase();
 * });
 *
 * // Use getTestPrisma() to get the Prisma client
 * const prisma = getTestPrisma();
 * ```
 */

import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let testPrisma: PrismaClient | null = null;
let tempDir: string | null = null;

/**
 * Set up an in-memory SQLite database for testing.
 * Creates a temporary directory with a SQLite file and runs migrations.
 */
export async function setupTestDatabase(): Promise<PrismaClient> {
  // Create a temp directory for the SQLite file
  // SQLite :memory: doesn't work well with Prisma migrations, so we use a temp file
  tempDir = mkdtempSync(join(tmpdir(), 'prisma-test-'));
  const dbPath = join(tempDir, 'test.db');
  const databaseUrl = `file:${dbPath}`;

  // Set the DATABASE_URL for this test run
  process.env.DATABASE_URL = databaseUrl;

  // Run migrations using prisma db push (faster than migrate for tests)
  execSync('npx prisma db push --skip-generate', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  // Create a new Prisma client connected to the test database
  testPrisma = new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  });

  await testPrisma.$connect();

  return testPrisma;
}

/**
 * Clean up the test database.
 */
export async function teardownTestDatabase(): Promise<void> {
  if (testPrisma) {
    await testPrisma.$disconnect();
    testPrisma = null;
  }

  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
}

/**
 * Get the test Prisma client.
 * Throws if setupTestDatabase hasn't been called.
 */
export function getTestPrisma(): PrismaClient {
  if (!testPrisma) {
    throw new Error('Test database not set up. Call setupTestDatabase() first.');
  }
  return testPrisma;
}

/**
 * Clear all data from the test database.
 * Useful for resetting state between tests.
 */
export async function clearTestDatabase(): Promise<void> {
  const prisma = getTestPrisma();

  // Delete in order to respect foreign key constraints
  await prisma.claudeProcess.deleteMany();
  await prisma.message.deleteMany();
  await prisma.session.deleteMany();
  await prisma.authSession.deleteMany();
}
