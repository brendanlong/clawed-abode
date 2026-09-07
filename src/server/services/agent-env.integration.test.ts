import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getBaseEnv, resetBaseEnvCache } from './agent-env';

// Spawns a real login shell.
describe('getBaseEnv', () => {
  const SENTINEL = 'CLAWED_ABODE_TEST_SERVER_ONLY_VAR';

  beforeEach(() => {
    resetBaseEnvCache();
    process.env[SENTINEL] = 'set-in-server-process';
  });
  afterAll(() => {
    delete process.env[SENTINEL];
  });

  it('captures PATH and HOME from a login shell but not the server process env', async () => {
    const baseEnv = await getBaseEnv();
    expect(baseEnv.PATH).toBeDefined();
    expect(baseEnv.HOME).toBeDefined();
    expect(baseEnv[SENTINEL]).toBeUndefined();
  });

  it('caches the result and coalesces concurrent calls', async () => {
    const [first, second] = await Promise.all([getBaseEnv(), getBaseEnv()]);
    expect(first).toBe(second);
    expect(await getBaseEnv()).toBe(first);
  });
});
