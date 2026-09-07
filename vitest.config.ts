import { defineConfig } from 'vitest/config';
import path from 'path';

const alias = { '@': path.resolve(__dirname, './src') };

/**
 * One config, three projects (select with `vitest run --project <name>`):
 * - unit: pure `*.test.ts` under node
 * - component: `*.test.tsx` under jsdom
 * - integration: `*.integration.test.ts` under node, against a real SQLite DB
 *   migrated once per run (src/test/global-setup-integration.ts)
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts', 'src/generated/**', 'src/test/**'],
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          globals: true,
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
          setupFiles: ['src/test/setup-unit.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'component',
          globals: true,
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['src/test/setup-component.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          globals: true,
          environment: 'node',
          include: ['src/**/*.integration.test.ts'],
          globalSetup: ['src/test/global-setup-integration.ts'],
          testTimeout: 30000, // git/SDK operations
        },
      },
    ],
  },
});
