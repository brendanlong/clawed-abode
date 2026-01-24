import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    // Exclude e2e tests - they require special environment setup (images, podman socket, etc.)
    exclude: ['src/test/e2e.integration.test.ts'],
    testTimeout: 30000, // Longer timeout for Docker/git operations
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
