import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30000, // Longer timeout for git/SDK operations
    // Every file's beforeAll runs `npx prisma migrate deploy`; eight of them in
    // parallel on a small CI runner regularly exceed vitest's 10s default.
    hookTimeout: 60000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
