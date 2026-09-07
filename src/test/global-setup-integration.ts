import type { TestProject } from 'vitest/node';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Fully migrated, empty SQLite file that each integration file copies for itself. */
    testDbTemplate: string;
  }
}

/**
 * Migrate one template database per run instead of once per test file: eight
 * concurrent `prisma migrate deploy` cold starts on a small CI runner used to blow
 * past the hook timeout. Files copy the template (a few ms) in setupTestDb.
 */
export default function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), 'clawed-test-template-'));
  const template = join(dir, 'template.db');
  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: `file:${template}` },
    stdio: 'inherit',
  });
  project.provide('testDbTemplate', template);
  return () => rmSync(dir, { recursive: true, force: true });
}
