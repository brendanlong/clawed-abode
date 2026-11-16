import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// `dotenv/config` loads .env for Prisma CLI commands (it never overrides an
// already-set variable, so tests that export DATABASE_URL keep their value). We
// read process.env rather than Prisma's `env()` helper because the helper throws
// when the variable is unset (e.g. `prisma generate` at install time with no
// .env); the default mirrors DATABASE_URL's default in src/lib/env.ts.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'file:./data/dev.db',
  },
});
