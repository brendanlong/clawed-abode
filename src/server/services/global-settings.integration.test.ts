import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

let globalSettings: typeof import('./global-settings');

describe('global-settings', () => {
  beforeAll(async () => {
    await setupTestDb();
    // After setupTestDb, so @/lib/prisma binds to the test database.
    globalSettings = await import('./global-settings');
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  it('reads the defaults before the row exists', async () => {
    expect(await globalSettings.loadGlobalSettings()).toEqual(
      globalSettings.GLOBAL_SETTINGS_DEFAULTS
    );
  });

  it('declares the same defaults the schema gives a new row', async () => {
    await globalSettings.patchGlobalSettings({});
    expect(await testPrisma.globalSettings.count()).toBe(1);
    expect(await globalSettings.loadGlobalSettings()).toEqual(
      globalSettings.GLOBAL_SETTINGS_DEFAULTS
    );
  });

  it('patches only the given fields, creating the row on first use', async () => {
    await globalSettings.patchGlobalSettings({ ttsSpeed: 1.5 });
    await globalSettings.patchGlobalSettings({ voiceAutoSend: false });

    expect(await globalSettings.loadGlobalSettings()).toEqual({
      ...globalSettings.GLOBAL_SETTINGS_DEFAULTS,
      ttsSpeed: 1.5,
      voiceAutoSend: false,
    });
  });
});
