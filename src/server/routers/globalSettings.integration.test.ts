import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));

// These will be set in beforeAll after the test DB is set up
let globalSettingsRouter: Awaited<typeof import('./globalSettings')>['globalSettingsRouter'];
let router: Awaited<typeof import('../trpc')>['router'];

const createCaller = () => {
  const testRouter = router({
    globalSettings: globalSettingsRouter,
  });
  // Use a fake session ID to pass the auth check
  return testRouter.createCaller({ sessionId: 'test-session', rotatedToken: null });
};

describe('globalSettings router', () => {
  beforeAll(async () => {
    await setupTestDb();

    // Dynamically import after DB setup
    const globalSettingsModule = await import('./globalSettings');
    const trpcModule = await import('../trpc');
    globalSettingsRouter = globalSettingsModule.globalSettingsRouter;
    router = trpcModule.router;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  describe('get', () => {
    it('should return defaults when no settings exist', async () => {
      const caller = createCaller();
      const result = await caller.globalSettings.get();

      expect(result).toEqual({
        systemPromptOverride: null,
        systemPromptOverrideEnabled: false,
        systemPromptAppend: null,
      });
    });

    it('should return saved settings', async () => {
      const caller = createCaller();

      await testPrisma.globalSettings.create({
        data: {
          id: 'global',
          systemPromptOverride: 'Custom override',
          systemPromptOverrideEnabled: true,
          systemPromptAppend: 'Custom append',
        },
      });

      const result = await caller.globalSettings.get();

      expect(result.systemPromptOverride).toBe('Custom override');
      expect(result.systemPromptOverrideEnabled).toBe(true);
      expect(result.systemPromptAppend).toBe('Custom append');
    });
  });

  describe('getDefaultSystemPrompt', () => {
    it('should return the default system prompt', async () => {
      const caller = createCaller();
      const result = await caller.globalSettings.getDefaultSystemPrompt();

      expect(result.defaultSystemPrompt).toBeDefined();
      expect(result.defaultSystemPrompt).toContain('commit');
      expect(result.defaultSystemPrompt).toContain('push');
    });
  });

  describe('setSystemPromptOverride', () => {
    it('should set the system prompt override', async () => {
      const caller = createCaller();
      const customPrompt = 'My custom system prompt override';

      await caller.globalSettings.setSystemPromptOverride({
        systemPromptOverride: customPrompt,
        systemPromptOverrideEnabled: true,
      });

      const result = await caller.globalSettings.get();
      expect(result.systemPromptOverride).toBe(customPrompt);
      expect(result.systemPromptOverrideEnabled).toBe(true);
    });

    it('should clear the override when set to null', async () => {
      const caller = createCaller();

      // First set an override
      await caller.globalSettings.setSystemPromptOverride({
        systemPromptOverride: 'Some override',
        systemPromptOverrideEnabled: true,
      });

      // Then clear it
      await caller.globalSettings.setSystemPromptOverride({
        systemPromptOverride: null,
        systemPromptOverrideEnabled: false,
      });

      const result = await caller.globalSettings.get();
      expect(result.systemPromptOverride).toBeNull();
      expect(result.systemPromptOverrideEnabled).toBe(false);
    });

    it('should trim whitespace from override', async () => {
      const caller = createCaller();

      await caller.globalSettings.setSystemPromptOverride({
        systemPromptOverride: '  Custom prompt with whitespace  ',
        systemPromptOverrideEnabled: true,
      });

      const result = await caller.globalSettings.get();
      expect(result.systemPromptOverride).toBe('Custom prompt with whitespace');
    });

    it('should set override to null for empty string', async () => {
      const caller = createCaller();

      await caller.globalSettings.setSystemPromptOverride({
        systemPromptOverride: '   ',
        systemPromptOverrideEnabled: true,
      });

      const result = await caller.globalSettings.get();
      expect(result.systemPromptOverride).toBeNull();
    });
  });

  describe('setSystemPromptAppend', () => {
    it('should set the system prompt append', async () => {
      const caller = createCaller();
      const appendContent = 'Always use TypeScript strict mode.';

      await caller.globalSettings.setSystemPromptAppend({
        systemPromptAppend: appendContent,
      });

      const result = await caller.globalSettings.get();
      expect(result.systemPromptAppend).toBe(appendContent);
    });

    it('should clear the append when set to null', async () => {
      const caller = createCaller();

      // First set an append
      await caller.globalSettings.setSystemPromptAppend({
        systemPromptAppend: 'Some append',
      });

      // Then clear it
      await caller.globalSettings.setSystemPromptAppend({
        systemPromptAppend: null,
      });

      const result = await caller.globalSettings.get();
      expect(result.systemPromptAppend).toBeNull();
    });

    it('should trim whitespace from append', async () => {
      const caller = createCaller();

      await caller.globalSettings.setSystemPromptAppend({
        systemPromptAppend: '  Trimmed content  ',
      });

      const result = await caller.globalSettings.get();
      expect(result.systemPromptAppend).toBe('Trimmed content');
    });
  });

  describe('toggleSystemPromptOverrideEnabled', () => {
    it('should toggle override enabled state', async () => {
      const caller = createCaller();

      // First set an override
      await caller.globalSettings.setSystemPromptOverride({
        systemPromptOverride: 'My override',
        systemPromptOverrideEnabled: true,
      });

      // Toggle off
      await caller.globalSettings.toggleSystemPromptOverrideEnabled({
        enabled: false,
      });

      let result = await caller.globalSettings.get();
      expect(result.systemPromptOverrideEnabled).toBe(false);
      expect(result.systemPromptOverride).toBe('My override'); // Override still exists

      // Toggle back on
      await caller.globalSettings.toggleSystemPromptOverrideEnabled({
        enabled: true,
      });

      result = await caller.globalSettings.get();
      expect(result.systemPromptOverrideEnabled).toBe(true);
    });

    it('should create settings if they do not exist', async () => {
      const caller = createCaller();

      await caller.globalSettings.toggleSystemPromptOverrideEnabled({
        enabled: true,
      });

      const result = await caller.globalSettings.get();
      expect(result.systemPromptOverrideEnabled).toBe(true);
    });
  });
});
