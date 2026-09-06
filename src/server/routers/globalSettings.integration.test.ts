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
  return testRouter.createCaller({ sessionId: 'test-session' });
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
        claudeModel: null,
        advisorModel: null,
        hasClaudeApiKey: false,
        ttsSpeed: null,
        voiceAutoSend: true,
        settingSources: { user: false, project: true, local: false },
        defaultClaudeModel: 'opus[1m]',
        suggestedAdvisorModel: 'claude-fable-5',
        hasEnvApiKey: true,
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

  describe('setSettingSources', () => {
    it('should persist the setting-source flags and reflect them in get', async () => {
      const caller = createCaller();

      await caller.globalSettings.setSettingSources({
        user: true,
        project: true,
        local: false,
      });

      const result = await caller.globalSettings.get();
      expect(result.settingSources).toEqual({ user: true, project: true, local: false });

      const row = await testPrisma.globalSettings.findUnique({ where: { id: 'global' } });
      expect(row?.settingSourceUser).toBe(true);
      expect(row?.settingSourceProject).toBe(true);
      expect(row?.settingSourceLocal).toBe(false);
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

  describe('setClaudeModel', () => {
    it('should set the Claude model', async () => {
      const caller = createCaller();

      await caller.globalSettings.setClaudeModel({ claudeModel: 'sonnet' });

      const result = await caller.globalSettings.get();
      expect(result.claudeModel).toBe('sonnet');
    });

    it('should clear the model when set to null', async () => {
      const caller = createCaller();

      await caller.globalSettings.setClaudeModel({ claudeModel: 'sonnet' });
      await caller.globalSettings.setClaudeModel({ claudeModel: null });

      const result = await caller.globalSettings.get();
      expect(result.claudeModel).toBeNull();
    });

    it('should clear the model when set to empty string', async () => {
      const caller = createCaller();

      await caller.globalSettings.setClaudeModel({ claudeModel: 'sonnet' });
      await caller.globalSettings.setClaudeModel({ claudeModel: '  ' });

      const result = await caller.globalSettings.get();
      expect(result.claudeModel).toBeNull();
    });

    it('should trim whitespace', async () => {
      const caller = createCaller();

      await caller.globalSettings.setClaudeModel({ claudeModel: '  opus  ' });

      const result = await caller.globalSettings.get();
      expect(result.claudeModel).toBe('opus');
    });
  });

  describe('setAdvisorModel', () => {
    it('should set the advisor model', async () => {
      const caller = createCaller();

      await caller.globalSettings.setAdvisorModel({ advisorModel: 'claude-opus-4-8' });

      const result = await caller.globalSettings.get();
      expect(result.advisorModel).toBe('claude-opus-4-8');
    });

    it('should default to null (advisor disabled) when unset', async () => {
      const caller = createCaller();

      const result = await caller.globalSettings.get();
      expect(result.advisorModel).toBeNull();
      expect(result.suggestedAdvisorModel).toBe('claude-fable-5');
    });

    it('should clear the model when set to null', async () => {
      const caller = createCaller();

      await caller.globalSettings.setAdvisorModel({ advisorModel: 'claude-opus-4-8' });
      await caller.globalSettings.setAdvisorModel({ advisorModel: null });

      const result = await caller.globalSettings.get();
      expect(result.advisorModel).toBeNull();
    });

    it('should trim whitespace and treat blank as cleared', async () => {
      const caller = createCaller();

      await caller.globalSettings.setAdvisorModel({ advisorModel: '  claude-sonnet-4-6  ' });
      expect((await caller.globalSettings.get()).advisorModel).toBe('claude-sonnet-4-6');

      await caller.globalSettings.setAdvisorModel({ advisorModel: '  ' });
      expect((await caller.globalSettings.get()).advisorModel).toBeNull();
    });
  });

  describe('setClaudeApiKey', () => {
    it('should set an encrypted API key', async () => {
      const caller = createCaller();

      await caller.globalSettings.setClaudeApiKey({ claudeApiKey: 'my-secret-token' });

      const result = await caller.globalSettings.get();
      expect(result.hasClaudeApiKey).toBe(true);

      // Verify it's encrypted in the DB
      const dbSettings = await testPrisma.globalSettings.findUnique({
        where: { id: 'global' },
      });
      expect(dbSettings!.claudeApiKey).not.toBe('my-secret-token');
      expect(dbSettings!.claudeApiKey).toContain(':'); // Encrypted format includes colons
    });

    it('should clear the API key when set to empty string', async () => {
      const caller = createCaller();

      await caller.globalSettings.setClaudeApiKey({ claudeApiKey: 'my-secret-token' });
      await caller.globalSettings.setClaudeApiKey({ claudeApiKey: '' });

      const result = await caller.globalSettings.get();
      expect(result.hasClaudeApiKey).toBe(false);
    });

    it('is decrypted in the resolved settings the runner loads', async () => {
      const caller = createCaller();

      await caller.globalSettings.setClaudeApiKey({ claudeApiKey: 'my-secret-token' });

      // Verify the service layer decrypts correctly
      const { loadResolvedGlobalSettings } = await import('../services/settings-merger');
      const resolved = await loadResolvedGlobalSettings();
      expect(resolved.claudeApiKey).toBe('my-secret-token');
    });
  });

  describe('scoped env var / MCP server procedures (global scope wiring)', () => {
    it('sets, lists masked, reveals and deletes a global secret env var', async () => {
      const caller = createCaller();
      await caller.globalSettings.setEnvVar({
        envVar: { name: 'TOKEN', value: 'shh', isSecret: true },
      });

      const { envVars } = await caller.globalSettings.getWithSettings();
      expect(envVars).toMatchObject([{ name: 'TOKEN', value: '••••••••', isSecret: true }]);
      expect(await caller.globalSettings.getEnvVarValue({ name: 'TOKEN' })).toEqual({
        value: 'shh',
      });

      const row = await testPrisma.envVar.findFirstOrThrow({ where: { name: 'TOKEN' } });
      expect(row.repoSettingsId).toBeNull();

      await caller.globalSettings.deleteEnvVar({ name: 'TOKEN' });
      expect(await testPrisma.envVar.count()).toBe(0);
    });

    it('stores a global MCP server with repoSettingsId null and lists it masked', async () => {
      const caller = createCaller();
      await caller.globalSettings.setMcpServer({
        mcpServer: {
          name: 'srv',
          type: 'http',
          url: 'https://mcp.example.com',
          headers: { Authorization: { value: 'Bearer t', isSecret: true } },
        },
      });
      const { mcpServers } = await caller.globalSettings.getWithSettings();
      expect(mcpServers).toMatchObject([
        {
          name: 'srv',
          type: 'http',
          headers: { Authorization: { value: '••••••••', isSecret: true } },
        },
      ]);
      expect((await testPrisma.mcpServer.findFirstOrThrow()).repoSettingsId).toBeNull();
      await caller.globalSettings.deleteMcpServer({ name: 'srv' });
      expect(await testPrisma.mcpServer.count()).toBe(0);
    });
  });

  describe('getWithSettings', () => {
    it('should return empty arrays when no settings exist', async () => {
      const caller = createCaller();
      const result = await caller.globalSettings.getWithSettings();

      expect(result.envVars).toEqual([]);
      expect(result.mcpServers).toEqual([]);
    });

    it('should return all env vars and MCP servers', async () => {
      const caller = createCaller();

      await caller.globalSettings.setEnvVar({
        envVar: { name: 'VAR1', value: 'value1', isSecret: false },
      });
      await caller.globalSettings.setEnvVar({
        envVar: { name: 'VAR2', value: 'value2', isSecret: false },
      });
      await caller.globalSettings.setMcpServer({
        mcpServer: { name: 'server1', type: 'stdio', command: 'node' },
      });

      const result = await caller.globalSettings.getWithSettings();
      expect(result.envVars).toHaveLength(2);
      expect(result.mcpServers).toHaveLength(1);
    });
  });
});
