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
let repoSettingsRouter: Awaited<typeof import('./repoSettings')>['repoSettingsRouter'];
let router: Awaited<typeof import('../trpc')>['router'];

const createCaller = () => {
  const testRouter = router({
    repoSettings: repoSettingsRouter,
  });
  // Use a fake session ID to pass the auth check
  return testRouter.createCaller({ sessionId: 'test-session', rotatedToken: null });
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

  describe('setEnvVar', () => {
    it('should create a non-secret env var', async () => {
      const caller = createCaller();

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'MY_VAR',
          value: 'my-value',
          isSecret: false,
        },
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.envVars).toHaveLength(1);
      expect(settings?.envVars[0].name).toBe('MY_VAR');
      expect(settings?.envVars[0].value).toBe('my-value');
      expect(settings?.envVars[0].isSecret).toBe(false);
    });

    it('should create an encrypted secret env var', async () => {
      const caller = createCaller();

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'SECRET_VAR',
          value: 'secret-value',
          isSecret: true,
        },
      });

      // Check that the value is masked in the response
      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.envVars[0].name).toBe('SECRET_VAR');
      expect(settings?.envVars[0].value).toBe('••••••••');
      expect(settings?.envVars[0].isSecret).toBe(true);

      // Check that the raw value is encrypted in the database
      const dbSettings = await testPrisma.repoSettings.findUnique({
        where: { repoFullName: testRepoName },
        include: { envVars: true },
      });
      expect(dbSettings?.envVars[0].value).not.toBe('secret-value');
      expect(dbSettings?.envVars[0].value).toContain(':'); // Encrypted format includes colons
    });

    it('should update an existing env var', async () => {
      const caller = createCaller();

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'MY_VAR',
          value: 'initial-value',
          isSecret: false,
        },
      });

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'MY_VAR',
          value: 'updated-value',
          isSecret: false,
        },
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.envVars).toHaveLength(1);
      expect(settings?.envVars[0].value).toBe('updated-value');
    });

    it('should preserve existing secret value when updated with empty string', async () => {
      const caller = createCaller();

      // Create a secret env var
      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'SECRET_VAR',
          value: 'my-secret-value',
          isSecret: true,
        },
      });

      // Update with empty value (simulates UI not changing the secret)
      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'SECRET_VAR',
          value: '',
          isSecret: true,
        },
      });

      // The original secret should be preserved
      const result = await caller.repoSettings.getEnvVarValue({
        repoFullName: testRepoName,
        name: 'SECRET_VAR',
      });
      expect(result.value).toBe('my-secret-value');
    });
  });

  describe('deleteEnvVar', () => {
    it('should delete an env var', async () => {
      const caller = createCaller();

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'TO_DELETE',
          value: 'value',
          isSecret: false,
        },
      });

      await caller.repoSettings.deleteEnvVar({
        repoFullName: testRepoName,
        name: 'TO_DELETE',
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.envVars).toHaveLength(0);
    });
  });

  describe('setMcpServer', () => {
    it('should create an MCP server config', async () => {
      const caller = createCaller();

      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
        mcpServer: {
          name: 'memory',
          type: 'stdio',
          command: 'npx',
          args: ['@anthropic/mcp-server-memory'],
        },
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.mcpServers).toHaveLength(1);
      expect(settings?.mcpServers[0].name).toBe('memory');
      expect(settings?.mcpServers[0].type).toBe('stdio');
      expect(settings?.mcpServers[0].command).toBe('npx');
      expect(settings?.mcpServers[0].args).toEqual(['@anthropic/mcp-server-memory']);
    });

    it('should create an MCP server with secret env var', async () => {
      const caller = createCaller();

      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
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

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.mcpServers[0].env.API_KEY.value).toBe('••••••••');
      expect(settings?.mcpServers[0].env.API_KEY.isSecret).toBe(true);
      expect(settings?.mcpServers[0].env.DEBUG.value).toBe('true');
      expect(settings?.mcpServers[0].env.DEBUG.isSecret).toBe(false);
    });
  });

  describe('deleteMcpServer', () => {
    it('should delete an MCP server config', async () => {
      const caller = createCaller();

      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
        mcpServer: {
          name: 'to-delete',
          type: 'stdio',
          command: 'node',
        },
      });

      await caller.repoSettings.deleteMcpServer({
        repoFullName: testRepoName,
        name: 'to-delete',
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.mcpServers).toHaveLength(0);
    });
  });

  describe('setMcpServer (HTTP)', () => {
    it('should create an HTTP MCP server config', async () => {
      const caller = createCaller();

      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
        mcpServer: {
          name: 'my-http-server',
          type: 'http',
          url: 'https://mcp.example.com/api',
        },
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.mcpServers).toHaveLength(1);
      expect(settings?.mcpServers[0].name).toBe('my-http-server');
      expect(settings?.mcpServers[0].type).toBe('http');
      expect(settings?.mcpServers[0].url).toBe('https://mcp.example.com/api');
      expect(settings?.mcpServers[0].command).toBe('');
    });

    it('should create an SSE MCP server config', async () => {
      const caller = createCaller();

      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
        mcpServer: {
          name: 'my-sse-server',
          type: 'sse',
          url: 'https://mcp.example.com/sse',
        },
      });

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.mcpServers).toHaveLength(1);
      expect(settings?.mcpServers[0].name).toBe('my-sse-server');
      expect(settings?.mcpServers[0].type).toBe('sse');
      expect(settings?.mcpServers[0].url).toBe('https://mcp.example.com/sse');
    });

    it('should create an HTTP MCP server with secret headers', async () => {
      const caller = createCaller();

      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
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

      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.mcpServers[0].headers.Authorization.value).toBe('••••••••');
      expect(settings?.mcpServers[0].headers.Authorization.isSecret).toBe(true);
      expect(settings?.mcpServers[0].headers['X-Custom'].value).toBe('public-value');
      expect(settings?.mcpServers[0].headers['X-Custom'].isSecret).toBe(false);
    });

    it('should preserve secret header when updated with empty value', async () => {
      const caller = createCaller();

      // Create an HTTP MCP server with a secret header
      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
        mcpServer: {
          name: 'authed-server',
          type: 'http',
          url: 'https://mcp.example.com/api',
          headers: {
            Authorization: { value: 'Bearer secret-token', isSecret: true },
          },
        },
      });

      // Update the server with empty header value (simulates UI not changing the secret)
      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
        mcpServer: {
          name: 'authed-server',
          type: 'http',
          url: 'https://mcp.example.com/api-v2',
          headers: {
            Authorization: { value: '', isSecret: true },
          },
        },
      });

      // Verify the URL was updated
      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.mcpServers[0].url).toBe('https://mcp.example.com/api-v2');

      // Verify the secret header was preserved via getForContainer
      const containerSettings = await caller.repoSettings.getForContainer({
        repoFullName: testRepoName,
      });
      const server = containerSettings?.mcpServers[0];
      expect(server && 'headers' in server ? server.headers?.Authorization : undefined).toBe(
        'Bearer secret-token'
      );
    });

    it('should preserve secret env var in stdio server when updated with empty value', async () => {
      const caller = createCaller();

      // Create a stdio MCP server with a secret env var
      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
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

      // Update the server, changing command but not the secret env var
      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
        mcpServer: {
          name: 'api-server',
          type: 'stdio',
          command: 'npx',
          args: ['server.js'],
          env: {
            API_KEY: { value: '', isSecret: true },
            DEBUG: { value: 'false', isSecret: false },
          },
        },
      });

      // Verify the command was updated
      const settings = await caller.repoSettings.get({ repoFullName: testRepoName });
      expect(settings?.mcpServers[0].command).toBe('npx');
      expect(settings?.mcpServers[0].env.DEBUG.value).toBe('false');

      // Verify the secret env var was preserved via getForContainer
      const containerSettings = await caller.repoSettings.getForContainer({
        repoFullName: testRepoName,
      });
      const server = containerSettings?.mcpServers[0];
      expect(server && 'env' in server ? server.env?.API_KEY : undefined).toBe('secret-api-key');
    });

    it('should return decrypted HTTP MCP server headers in getForContainer', async () => {
      const caller = createCaller();

      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
        mcpServer: {
          name: 'container-http-server',
          type: 'http',
          url: 'https://mcp.example.com/api',
          headers: {
            Authorization: { value: 'Bearer my-secret-token', isSecret: true },
          },
        },
      });

      const result = await caller.repoSettings.getForContainer({ repoFullName: testRepoName });
      const server = result?.mcpServers[0];
      expect(server?.name).toBe('container-http-server');
      expect(server?.type).toBe('http');
      expect(server && 'url' in server ? server.url : undefined).toBe(
        'https://mcp.example.com/api'
      );
      expect(server && 'headers' in server ? server.headers?.Authorization : undefined).toBe(
        'Bearer my-secret-token'
      );
    });

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

  describe('getForContainer', () => {
    it('should return decrypted env vars', async () => {
      const caller = createCaller();

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'SECRET',
          value: 'my-secret-value',
          isSecret: true,
        },
      });

      const result = await caller.repoSettings.getForContainer({ repoFullName: testRepoName });
      expect(result?.envVars[0].name).toBe('SECRET');
      expect(result?.envVars[0].value).toBe('my-secret-value'); // Decrypted!
    });

    it('should return decrypted MCP server env vars', async () => {
      const caller = createCaller();

      await caller.repoSettings.setMcpServer({
        repoFullName: testRepoName,
        mcpServer: {
          name: 'test-server',
          type: 'stdio',
          command: 'node',
          env: {
            API_KEY: { value: 'secret-key', isSecret: true },
          },
        },
      });

      const result = await caller.repoSettings.getForContainer({ repoFullName: testRepoName });
      const server = result?.mcpServers[0];
      expect(server?.type).toBe('stdio');
      expect(server && 'env' in server ? server.env?.API_KEY : undefined).toBe('secret-key'); // Decrypted!
    });
  });

  describe('getEnvVarValue', () => {
    it('should return decrypted value for secret env var', async () => {
      const caller = createCaller();

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'SECRET_VAR',
          value: 'my-secret-value',
          isSecret: true,
        },
      });

      const result = await caller.repoSettings.getEnvVarValue({
        repoFullName: testRepoName,
        name: 'SECRET_VAR',
      });
      expect(result.value).toBe('my-secret-value');
    });

    it('should return plain value for non-secret env var', async () => {
      const caller = createCaller();

      await caller.repoSettings.setEnvVar({
        repoFullName: testRepoName,
        envVar: {
          name: 'PLAIN_VAR',
          value: 'plain-value',
          isSecret: false,
        },
      });

      const result = await caller.repoSettings.getEnvVarValue({
        repoFullName: testRepoName,
        name: 'PLAIN_VAR',
      });
      expect(result.value).toBe('plain-value');
    });

    it('should throw NOT_FOUND for non-existent repo', async () => {
      const caller = createCaller();

      await expect(
        caller.repoSettings.getEnvVarValue({
          repoFullName: 'nonexistent/repo',
          name: 'VAR',
        })
      ).rejects.toThrow('Repository settings not found');
    });

    it('should throw NOT_FOUND for non-existent env var', async () => {
      const caller = createCaller();

      await caller.repoSettings.toggleFavorite({
        repoFullName: testRepoName,
        isFavorite: true,
      });

      await expect(
        caller.repoSettings.getEnvVarValue({
          repoFullName: testRepoName,
          name: 'NONEXISTENT',
        })
      ).rejects.toThrow('Environment variable not found');
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

    it('should include customSystemPrompt in getForContainer', async () => {
      const caller = createCaller();
      const customPrompt = 'Custom prompt for container';

      await caller.repoSettings.setCustomSystemPrompt({
        repoFullName: testRepoName,
        customSystemPrompt: customPrompt,
      });

      const result = await caller.repoSettings.getForContainer({ repoFullName: testRepoName });
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
