import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

vi.mock('@/lib/logger', async () => (await import('@/test/mock-logger')).mockLoggerModule());

// These will be set in beforeAll after the test DB is set up
let repoSettingsRouter: Awaited<typeof import('./repoSettings')>['repoSettingsRouter'];
let router: Awaited<typeof import('../trpc')>['router'];
let loadResolvedRepoSettings: Awaited<
  typeof import('../services/settings-merger')
>['loadResolvedRepoSettings'];

const createCaller = () => {
  const testRouter = router({
    repoSettings: repoSettingsRouter,
  });
  // Use a fake session ID to pass the auth check
  return testRouter.createCaller({ sessionId: 'test-session' });
};

describe('repoSettings router', () => {
  const testRepoName = 'test-owner/test-repo';

  beforeAll(async () => {
    await setupTestDb();

    // Dynamically import after DB setup
    const repoSettingsModule = await import('./repoSettings');
    const trpcModule = await import('../trpc');
    repoSettingsRouter = repoSettingsModule.repoSettingsRouter;
    router = trpcModule.router;
    loadResolvedRepoSettings = (await import('../services/settings-merger'))
      .loadResolvedRepoSettings;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  describe('toggleFavorite', () => {
    it('should create settings and set favorite to true', async () => {
      const caller = createCaller();
      const result = await caller.repoSettings.toggleFavorite({
        repoFullName: testRepoName,
        isFavorite: true,
      });

      expect(result.isFavorite).toBe(true);

      const settings = await testPrisma.repoSettings.findUnique({
        where: { repoFullName: testRepoName },
      });
      expect(settings?.isFavorite).toBe(true);
    });

    it('should toggle favorite off', async () => {
      const caller = createCaller();

      // First set to true
      await caller.repoSettings.toggleFavorite({
        repoFullName: testRepoName,
        isFavorite: true,
      });

      // Then toggle off
      const result = await caller.repoSettings.toggleFavorite({
        repoFullName: testRepoName,
        isFavorite: false,
      });

      expect(result.isFavorite).toBe(false);
    });
  });

  describe('listFavorites', () => {
    it('should return empty list when no favorites', async () => {
      const caller = createCaller();
      const result = await caller.repoSettings.listFavorites();
      expect(result.favorites).toEqual([]);
    });

    it('should return favorite repos', async () => {
      const caller = createCaller();

      await caller.repoSettings.toggleFavorite({
        repoFullName: testRepoName,
        isFavorite: true,
      });

      const result = await caller.repoSettings.listFavorites();
      expect(result.favorites).toContain(testRepoName);
    });
  });

  describe('setMcpServer input validation', () => {
    it('should reject HTTP MCP server without URL', async () => {
      const caller = createCaller();

      await expect(
        caller.repoSettings.setMcpServer({
          repoFullName: testRepoName,
          mcpServer: {
            name: 'no-url-server',
            type: 'http',
            url: '',
          } as Parameters<typeof caller.repoSettings.setMcpServer>[0]['mcpServer'],
        })
      ).rejects.toThrow();
    });

    it('should reject HTTP MCP server with invalid URL', async () => {
      const caller = createCaller();

      await expect(
        caller.repoSettings.setMcpServer({
          repoFullName: testRepoName,
          mcpServer: {
            name: 'bad-url-server',
            type: 'http',
            url: 'not-a-url',
          },
        })
      ).rejects.toThrow();
    });
  });

  describe('scoped env var / MCP server procedures (repo scope wiring)', () => {
    it('creates the RepoSettings row on first write and scopes the entry to it', async () => {
      const caller = createCaller();
      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: { name: 'TOKEN', value: 'shh', isSecret: true },
      });
      const settings = await testPrisma.repoSettings.findUniqueOrThrow({
        where: { repoFullName: testRepoName },
        include: { envVars: true },
      });
      expect(settings.envVars).toMatchObject([{ name: 'TOKEN', isSecret: true }]);
      expect(
        await caller.repoSettings.getEnvVarValue({ repoFullName: testRepoName, name: 'TOKEN' })
      ).toEqual({ value: 'shh' });

      const view = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(view?.envVars[0].value).toBe('••••••••');

      const resolved = await loadResolvedRepoSettings(testRepoName);
      expect(resolved?.envVars).toEqual([{ name: 'TOKEN', value: 'shh' }]);
    });

    it('treats deletes for an unknown repo as a no-op', async () => {
      const caller = createCaller();
      await expect(
        caller.repoSettings.deleteEnvVar({ repoFullName: 'no/such', name: 'X' })
      ).resolves.toEqual({ success: true });
      await expect(
        caller.repoSettings.deleteMcpServer({ repoFullName: 'no/such', name: 'x' })
      ).resolves.toEqual({ success: true });
      expect(await testPrisma.repoSettings.count()).toBe(0);
    });
  });

  describe('getEnvVarValue', () => {
    it('should throw NOT_FOUND for non-existent repo', async () => {
      const caller = createCaller();

      await expect(
        caller.repoSettings.getEnvVarValue({
          repoFullName: 'nonexistent/repo',
          name: 'VAR',
        })
      ).rejects.toThrow('Repository settings not found');
    });
  });

  describe('delete', () => {
    it('should delete all settings for a repo', async () => {
      const caller = createCaller();

      await caller.repoSettings.toggleFavorite({
        repoFullName: testRepoName,
        isFavorite: true,
      });

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'VAR',
          value: 'value',
          isSecret: false,
        },
      });

      await caller.repoSettings.delete({ repoFullName: testRepoName });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings).toBeNull();
    });
  });

  describe('listWithSettings', () => {
    it('should list repos with settings summary', async () => {
      const caller = createCaller();

      await caller.repoSettings.toggleFavorite({
        repoFullName: testRepoName,
        isFavorite: true,
      });

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'VAR1',
          value: 'value',
          isSecret: false,
        },
      });

      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
        mcpServer: {
          name: 'server1',
          type: 'stdio',
          command: 'node',
        },
      });

      const result = await caller.repoSettings.listWithSettings();
      const found = result.settings.find((s) => s.repoFullName === testRepoName);
      expect(found).toBeDefined();
      expect(found?.isFavorite).toBe(true);
      expect(found?.envVarCount).toBe(1);
      expect(found?.mcpServerCount).toBe(1);
    });
  });

  describe('setCustomSystemPrompt', () => {
    it('should set a custom system prompt', async () => {
      const caller = createCaller();
      const customPrompt = 'Always use TypeScript strict mode. Never use any type.';

      await caller.repoSettings.setCustomSystemPrompt({
        repoFullName: testRepoName,
        customSystemPrompt: customPrompt,
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.customSystemPrompt).toBe(customPrompt);
    });

    it('should create settings if they do not exist', async () => {
      const caller = createCaller();
      const customPrompt = 'This is a new repo prompt.';

      await caller.repoSettings.setCustomSystemPrompt({
        repoFullName: 'new/repo',
        customSystemPrompt: customPrompt,
      });

      const settings = await caller.repoSettings.get({ repoFullName: 'new/repo' });
      expect(settings?.customSystemPrompt).toBe(customPrompt);
      expect(settings?.isFavorite).toBe(false);
    });

    it('should update an existing custom system prompt', async () => {
      const caller = createCaller();

      await caller.repoSettings.setCustomSystemPrompt({
        repoFullName: testRepoName,
        customSystemPrompt: 'Initial prompt',
      });

      await caller.repoSettings.setCustomSystemPrompt({
        repoFullName: testRepoName,
        customSystemPrompt: 'Updated prompt',
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.customSystemPrompt).toBe('Updated prompt');
    });

    it('should clear the custom system prompt when set to null', async () => {
      const caller = createCaller();

      await caller.repoSettings.setCustomSystemPrompt({
        repoFullName: testRepoName,
        customSystemPrompt: 'Some prompt',
      });

      await caller.repoSettings.setCustomSystemPrompt({
        repoFullName: testRepoName,
        customSystemPrompt: null,
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.customSystemPrompt).toBeNull();
    });

    it('should clear the custom system prompt when set to empty string', async () => {
      const caller = createCaller();

      await caller.repoSettings.setCustomSystemPrompt({
        repoFullName: testRepoName,
        customSystemPrompt: 'Some prompt',
      });

      await caller.repoSettings.setCustomSystemPrompt({
        repoFullName: testRepoName,
        customSystemPrompt: '   ', // whitespace only
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.customSystemPrompt).toBeNull();
    });

    it('is included in the resolved settings the runner loads', async () => {
      const caller = createCaller();
      const customPrompt = 'Custom prompt for this repo';

      await caller.repoSettings.setCustomSystemPrompt({
        repoFullName: testRepoName,
        customSystemPrompt: customPrompt,
      });

      const result = await loadResolvedRepoSettings(testRepoName);
      expect(result?.customSystemPrompt).toBe(customPrompt);
    });

    it('should include customSystemPrompt in listWithSettings', async () => {
      const caller = createCaller();
      const customPrompt = 'My custom prompt';

      await caller.repoSettings.setCustomSystemPrompt({
        repoFullName: testRepoName,
        customSystemPrompt: customPrompt,
      });

      const result = await caller.repoSettings.listWithSettings();
      const found = result.settings.find((s) => s.repoFullName === testRepoName);
      expect(found?.customSystemPrompt).toBe(customPrompt);
    });
  });
});
