import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 7 moved the datasource URL and CLI configuration out of schema.prisma
// into this file. The URL here is used by the Prisma CLI (migrate/generate/db
// push); the application runtime connects via the better-sqlite3 driver adapter
// in src/lib/prisma.ts, which reads DATABASE_URL directly.
//
// `dotenv/config` reproduces the pre-v7 behavior of auto-loading .env for CLI
// commands (dotenv never overrides an already-set env var, so tests that export
// DATABASE_URL before invoking the CLI keep their value). We read process.env
// directly rather than the `env()` helper because the helper throws when the
// variable is unset (e.g. `prisma generate` at install time with no .env
// present); the default mirrors DATABASE_URL's default in src/lib/env.ts.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'file:./data/dev.db',
  },
});
