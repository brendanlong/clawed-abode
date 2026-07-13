import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@/generated/prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Prisma 7 requires a driver adapter for the datasource. The better-sqlite3
// adapter opens the SQLite file directly (no Rust query engine). We read the
// connection string from process.env rather than the validated `@/lib/env`
// module because this is the lowest-level infra seam (tests mock `@/lib/env`)
// and Prisma's own config (prisma.config.ts) reads it the same way. The default
// mirrors DATABASE_URL's default in src/lib/env.ts.
function createPrismaClient(): PrismaClient {
  const adapter = new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL ?? 'file:./data/dev.db',
  });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
