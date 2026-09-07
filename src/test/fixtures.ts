import type { Prisma } from '@/generated/prisma/client';
import { testPrisma } from './setup-test-db';

/** A running repo session; override any column. */
export function createTestSession(overrides: Partial<Prisma.SessionCreateInput> = {}) {
  return testPrisma.session.create({
    data: {
      name: 'Test Session',
      repoUrl: 'https://github.com/owner/repo.git',
      branch: 'main',
      status: 'running',
      ...overrides,
    },
  });
}
