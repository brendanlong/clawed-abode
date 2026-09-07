import { vi } from 'vitest';

/**
 * Silences the logger while keeping `toError` real. vi.mock is hoisted above
 * imports, so reference this through a dynamic import inside the factory:
 *   vi.mock('@/lib/logger', async () => (await import('@/test/mock-logger')).mockLoggerModule());
 */
export function mockLoggerModule() {
  return {
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  };
}
