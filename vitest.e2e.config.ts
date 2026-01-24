import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/test/e2e.integration.test.ts'],
    // Very long timeout for e2e tests that build images and run Claude
    testTimeout: 900000, // 15 minutes
    hookTimeout: 900000, // 15 minutes for beforeAll/afterAll
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
