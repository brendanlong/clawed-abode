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

  describe('setEnvVar', () => {
    it('should create a non-secret env var', async () => {
      const caller = createCaller();

      await caller.globalSettings.setEnvVar({
        envVar: {
          name: 'MY_VAR',
          value: 'my-value',
          isSecret: false,
        },
      });

      const settings = await caller.globalSettings.getWithSettings();
      expect(settings.envVars).toHaveLength(1);
      expect(settings.envVars[0].name).toBe('MY_VAR');
      expect(settings.envVars[0].value).toBe('my-value');
      expect(settings.envVars[0].isSecret).toBe(false);
    });

    it('should create an encrypted secret env var', async () => {
      const caller = createCaller();

      await caller.globalSettings.setEnvVar({
        envVar: {
          name: 'SECRET_VAR',
          value: 'secret-value',
          isSecret: true,
        },
      });

      // Check that the value is masked in the response
      const settings = await caller.globalSettings.getWithSettings();
      expect(settings.envVars[0].name).toBe('SECRET_VAR');
      expect(settings.envVars[0].value).toBe('••••••••');
      expect(settings.envVars[0].isSecret).toBe(true);

      // Check that the raw value is encrypted in the database
      const dbSettings = await testPrisma.globalSettings.findUnique({
        where: { id: 'global' },
        include: { envVars: true },
      });
      expect(dbSettings?.envVars[0].value).not.toBe('secret-value');
      expect(dbSettings?.envVars[0].value).toContain(':'); // Encrypted format includes colons
    });

    it('should update an existing env var', async () => {
      const caller = createCaller();

      await caller.globalSettings.setEnvVar({
        envVar: {
          name: 'MY_VAR',
          value: 'initial-value',
          isSecret: false,
        },
      });

      await caller.globalSettings.setEnvVar({
        envVar: {
          name: 'MY_VAR',
          value: 'updated-value',
          isSecret: false,
        },
      });

      const settings = await caller.globalSettings.getWithSettings();
      expect(settings.envVars).toHaveLength(1);
      expect(settings.envVars[0].value).toBe('updated-value');
    });
  });

  describe('deleteEnvVar', () => {
    it('should delete an env var', async () => {
      const caller = createCaller();

      await caller.globalSettings.setEnvVar({
        envVar: {
          name: 'TO_DELETE',
          value: 'value',
          isSecret: false,
        },
      });

      await caller.globalSettings.deleteEnvVar({ name: 'TO_DELETE' });

      const settings = await caller.globalSettings.getWithSettings();
      expect(settings.envVars).toHaveLength(0);
    });
  });

  describe('getEnvVarValue', () => {
    it('should return decrypted value for secret env var', async () => {
      const caller = createCaller();

      await caller.globalSettings.setEnvVar({
        envVar: {
          name: 'SECRET_VAR',
          value: 'my-secret-value',
          isSecret: true,
        },
      });

      const result = await caller.globalSettings.getEnvVarValue({ name: 'SECRET_VAR' });
      expect(result.value).toBe('my-secret-value');
    });

    it('should return plain value for non-secret env var', async () => {
      const caller = createCaller();

      await caller.globalSettings.setEnvVar({
        envVar: {
          name: 'PLAIN_VAR',
          value: 'plain-value',
          isSecret: false,
        },
      });

      const result = await caller.globalSettings.getEnvVarValue({ name: 'PLAIN_VAR' });
      expect(result.value).toBe('plain-value');
    });

    it('should throw NOT_FOUND for non-existent env var', async () => {
      const caller = createCaller();

      // Create global settings first
      await caller.globalSettings.setEnvVar({
        envVar: {
          name: 'EXISTS',
          value: 'value',
          isSecret: false,
        },
      });

      await expect(caller.globalSettings.getEnvVarValue({ name: 'NONEXISTENT' })).rejects.toThrow(
        'Environment variable not found'
      );
    });
  });

  describe('setMcpServer', () => {
    it('should create an MCP server config', async () => {
      const caller = createCaller();

      await caller.globalSettings.setMcpServer({
        mcpServer: {
          name: 'memory',
          type: 'stdio',
          command: 'npx',
          args: ['@anthropic/mcp-server-memory'],
        },
      });

      const settings = await caller.globalSettings.getWithSettings();
      expect(settings.mcpServers).toHaveLength(1);
      expect(settings.mcpServers[0].name).toBe('memory');
      expect(settings.mcpServers[0].type).toBe('stdio');
      expect(settings.mcpServers[0].command).toBe('npx');
      expect(settings.mcpServers[0].args).toEqual(['@anthropic/mcp-server-memory']);
    });

    it('should create an MCP server with secret env var', async () => {
      const caller = createCaller();

      await caller.globalSettings.setMcpServer({
        mcpServer: {
          name: 'api-server',
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: {
            API_KEY: { value: 'secret-api-key', isSecret: true },
            DEBUG: { value: 'true', isSecret: false },
          },
        },
      });

      const settings = await caller.globalSettings.getWithSettings();
      expect(settings.mcpServers[0].env.API_KEY.value).toBe('••••••••');
      expect(settings.mcpServers[0].env.API_KEY.isSecret).toBe(true);
      expect(settings.mcpServers[0].env.DEBUG.value).toBe('true');
      expect(settings.mcpServers[0].env.DEBUG.isSecret).toBe(false);
    });

    it('should create an HTTP MCP server config', async () => {
      const caller = createCaller();

      await caller.globalSettings.setMcpServer({
        mcpServer: {
          name: 'my-http-server',
          type: 'http',
          url: 'https://mcp.example.com/api',
        },
      });

      const settings = await caller.globalSettings.getWithSettings();
      expect(settings.mcpServers).toHaveLength(1);
      expect(settings.mcpServers[0].name).toBe('my-http-server');
      expect(settings.mcpServers[0].type).toBe('http');
      expect(settings.mcpServers[0].url).toBe('https://mcp.example.com/api');
    });

    it('should create an HTTP MCP server with secret headers', async () => {
      const caller = createCaller();

      await caller.globalSettings.setMcpServer({
        mcpServer: {
          name: 'authed-server',
          type: 'http',
          url: 'https://mcp.example.com/api',
          headers: {
            Authorization: { value: 'Bearer secret-token', isSecret: true },
            'X-Custom': { value: 'public-value', isSecret: false },
          },
        },
      });

      const settings = await caller.globalSettings.getWithSettings();
      expect(settings.mcpServers[0].headers.Authorization.value).toBe('••••••••');
      expect(settings.mcpServers[0].headers.Authorization.isSecret).toBe(true);
      expect(settings.mcpServers[0].headers['X-Custom'].value).toBe('public-value');
      expect(settings.mcpServers[0].headers['X-Custom'].isSecret).toBe(false);
    });
  });

  describe('deleteMcpServer', () => {
    it('should delete an MCP server config', async () => {
      const caller = createCaller();

      await caller.globalSettings.setMcpServer({
        mcpServer: {
          name: 'to-delete',
          type: 'stdio',
          command: 'node',
        },
      });

      await caller.globalSettings.deleteMcpServer({ name: 'to-delete' });

      const settings = await caller.globalSettings.getWithSettings();
      expect(settings.mcpServers).toHaveLength(0);
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
