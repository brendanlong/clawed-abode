/**
 * Load .env from the repo root before any module that reads configuration.
 * Next.js does this automatically for the web server; the CLI must do it
 * itself. Imported for its side effect as the first import in index.ts.
 */

import { existsSync } from 'fs';
import { join } from 'path';

const envFile = join(__dirname, '..', '..', '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
