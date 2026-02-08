import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { encrypt, decrypt, isEncryptionConfigured } from '@/lib/crypto';
import { TRPCError } from '@trpc/server';
import { createLogger } from '@/lib/logger';
import { DEFAULT_SYSTEM_PROMPT } from '../services/claude-runner';

const log = createLogger('globalSettings');

// The singleton ID for global settings
const GLOBAL_SETTINGS_ID = 'global';

// Validation schemas (shared with repoSettings)
const envVarNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
    message:
      'Environment variable name must start with a letter or underscore and contain only alphanumeric characters and underscores',
  });

const envVarSchema = z.object({
  name: envVarNameSchema,
  value: z.string().max(10000),
  isSecret: z.boolean().default(false),
});

const mcpServerEnvValueSchema = z.object({
  value: z.string(),
  isSecret: z.boolean().default(false),
});

type McpServerEnvValue = z.infer<typeof mcpServerEnvValueSchema>;

const mcpServerEnvSchema = z.record(z.string(), mcpServerEnvValueSchema);

const mcpServerStdioSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.literal('stdio').default('stdio'),
  command: z.string().min(1).max(1000),
  args: z.array(z.string()).optional(),
  env: mcpServerEnvSchema.optional(),
});

const mcpServerHttpSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['http', 'sse']),
  url: z.string().url().max(2000),
  headers: mcpServerEnvSchema.optional(),
});

const mcpServerSchema = z.discriminatedUnion('type', [mcpServerStdioSchema, mcpServerHttpSchema]);

/**
 * Mask secret values for display
 */
function maskSecrets<T extends { value: string; isSecret: boolean }>(items: T[]): T[] {
  return items.map((item) => ({
    ...item,
    value: item.isSecret ? '••••••••' : item.value,
  }));
}

/**
 * Mask MCP server env secrets for display
 */
function maskMcpEnv(env: Record<string, McpServerEnvValue>): Record<string, McpServerEnvValue> {
  return Object.fromEntries(
    Object.entries(env).map(([key, { value, isSecret }]) => [
      key,
      { value: isSecret ? '••••••••' : value, isSecret },
    ])
  );
}

/**
 * Encrypt MCP server env secrets
 */
function encryptMcpEnv(env: Record<string, McpServerEnvValue>): Record<string, McpServerEnvValue> {
  return Object.fromEntries(
    Object.entries(env).map(([key, { value, isSecret }]) => [
      key,
      { value: isSecret ? encrypt(value) : value, isSecret },
    ])
  );
}

/**
 * Ensure the global settings singleton row exists.
 */
async function ensureGlobalSettings() {
  return prisma.globalSettings.upsert({
    where: { id: GLOBAL_SETTINGS_ID },
    create: { id: GLOBAL_SETTINGS_ID },
    update: {},
  });
}

export const globalSettingsRouter = router({
  /**
   * Get the default system prompt (built-in)
   * Used to pre-populate the override field in the UI
   */
  getDefaultSystemPrompt: protectedProcedure.query(() => {
    return { defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT };
  }),

  /**
   * Get the current global settings
   * Returns defaults if no settings exist yet
   */
  get: protectedProcedure.query(async () => {
    const settings = await prisma.globalSettings.findUnique({
      where: { id: GLOBAL_SETTINGS_ID },
    });

    if (!settings) {
      return {
        systemPromptOverride: null,
        systemPromptOverrideEnabled: false,
        systemPromptAppend: null,
      };
    }

    return {
      systemPromptOverride: settings.systemPromptOverride,
      systemPromptOverrideEnabled: settings.systemPromptOverrideEnabled,
      systemPromptAppend: settings.systemPromptAppend,
    };
  }),

  /**
   * Set the system prompt override
   * Pass null to clear the override
   */
  setSystemPromptOverride: protectedProcedure
    .input(
      z.object({
        systemPromptOverride: z.string().max(50000).nullable(),
        systemPromptOverrideEnabled: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      const override = input.systemPromptOverride?.trim() || null;

      await prisma.globalSettings.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        create: {
          id: GLOBAL_SETTINGS_ID,
          systemPromptOverride: override,
          systemPromptOverrideEnabled: input.systemPromptOverrideEnabled,
        },
        update: {
          systemPromptOverride: override,
          systemPromptOverrideEnabled: input.systemPromptOverrideEnabled,
        },
      });

      log.info('Set system prompt override', {
        hasOverride: override !== null,
        enabled: input.systemPromptOverrideEnabled,
      });

      return { success: true };
    }),

  /**
   * Set the system prompt append content
   * Pass null or empty string to clear
   */
  setSystemPromptAppend: protectedProcedure
    .input(
      z.object({
        systemPromptAppend: z.string().max(50000).nullable(),
      })
    )
    .mutation(async ({ input }) => {
      const append = input.systemPromptAppend?.trim() || null;

      await prisma.globalSettings.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        create: {
          id: GLOBAL_SETTINGS_ID,
          systemPromptAppend: append,
        },
        update: {
          systemPromptAppend: append,
        },
      });

      log.info('Set system prompt append', {
        hasAppend: append !== null,
      });

      return { success: true };
    }),

  /**
   * Toggle the system prompt override enabled state
   */
  toggleSystemPromptOverrideEnabled: protectedProcedure
    .input(
      z.object({
        enabled: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      await prisma.globalSettings.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        create: {
          id: GLOBAL_SETTINGS_ID,
          systemPromptOverrideEnabled: input.enabled,
        },
        update: {
          systemPromptOverrideEnabled: input.enabled,
        },
      });

      log.info('Toggled system prompt override', { enabled: input.enabled });

      return { success: true };
    }),

  /**
   * Get global settings with env vars and MCP servers (masked secrets)
   */
  getWithSettings: protectedProcedure.query(async () => {
    const settings = await prisma.globalSettings.findUnique({
      where: { id: GLOBAL_SETTINGS_ID },
      include: { envVars: true, mcpServers: true },
    });

    if (!settings) {
      return {
        envVars: [] as Array<{ id: string; name: string; value: string; isSecret: boolean }>,
        mcpServers: [] as Array<{
          id: string;
          name: string;
          type: 'stdio' | 'http' | 'sse';
          command: string;
          args: string[];
          env: Record<string, McpServerEnvValue>;
          url?: string;
          headers: Record<string, McpServerEnvValue>;
        }>,
      };
    }

    return {
      envVars: maskSecrets(
        settings.envVars.map((ev) => ({
          id: ev.id,
          name: ev.name,
          value: ev.value,
          isSecret: ev.isSecret,
        }))
      ),
      mcpServers: settings.mcpServers.map((mcp) => ({
        id: mcp.id,
        name: mcp.name,
        type: (mcp.type || 'stdio') as 'stdio' | 'http' | 'sse',
        command: mcp.command,
        args: mcp.args ? (JSON.parse(mcp.args) as string[]) : [],
        env: mcp.env ? maskMcpEnv(JSON.parse(mcp.env) as Record<string, McpServerEnvValue>) : {},
        url: mcp.url ?? undefined,
        headers: mcp.headers
          ? maskMcpEnv(JSON.parse(mcp.headers) as Record<string, McpServerEnvValue>)
          : {},
      })),
    };
  }),

  /**
   * Set (create or update) a global environment variable
   */
  setEnvVar: protectedProcedure
    .input(z.object({ envVar: envVarSchema }))
    .mutation(async ({ input }) => {
      if (input.envVar.isSecret && !isEncryptionConfigured()) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'ENCRYPTION_KEY must be configured to store secrets. See .env.example for instructions.',
        });
      }

      const settings = await ensureGlobalSettings();
      const value = input.envVar.isSecret ? encrypt(input.envVar.value) : input.envVar.value;

      await prisma.globalEnvVar.upsert({
        where: {
          globalSettingsId_name: {
            globalSettingsId: settings.id,
            name: input.envVar.name,
          },
        },
        create: {
          globalSettingsId: settings.id,
          name: input.envVar.name,
          value,
          isSecret: input.envVar.isSecret,
        },
        update: {
          value,
          isSecret: input.envVar.isSecret,
        },
      });

      log.info('Set global env var', {
        name: input.envVar.name,
        isSecret: input.envVar.isSecret,
      });

      return { success: true };
    }),

  /**
   * Delete a global environment variable
   */
  deleteEnvVar: protectedProcedure
    .input(z.object({ name: envVarNameSchema }))
    .mutation(async ({ input }) => {
      const settings = await prisma.globalSettings.findUnique({
        where: { id: GLOBAL_SETTINGS_ID },
      });

      if (settings) {
        await prisma.globalEnvVar.deleteMany({
          where: {
            globalSettingsId: settings.id,
            name: input.name,
          },
        });

        log.info('Deleted global env var', { name: input.name });
      }

      return { success: true };
    }),

  /**
   * Get the decrypted value of a secret global environment variable
   */
  getEnvVarValue: protectedProcedure
    .input(z.object({ name: envVarNameSchema }))
    .query(async ({ input }) => {
      const settings = await prisma.globalSettings.findUnique({
        where: { id: GLOBAL_SETTINGS_ID },
        include: { envVars: true },
      });

      if (!settings) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Global settings not found',
        });
      }

      const envVar = settings.envVars.find((ev) => ev.name === input.name);
      if (!envVar) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Environment variable not found',
        });
      }

      const value = envVar.isSecret ? decrypt(envVar.value) : envVar.value;
      return { value };
    }),

  /**
   * Set (create or update) a global MCP server configuration
   */
  setMcpServer: protectedProcedure
    .input(z.object({ mcpServer: mcpServerSchema }))
    .mutation(async ({ input }) => {
      const server = input.mcpServer;

      // Check secrets in env (stdio) or headers (http/sse)
      const secretEntries = server.type === 'stdio' ? (server.env ?? {}) : (server.headers ?? {});
      const hasSecrets = Object.values(secretEntries).some((e) => e.isSecret);
      if (hasSecrets && !isEncryptionConfigured()) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'ENCRYPTION_KEY must be configured to store secrets. See .env.example for instructions.',
        });
      }

      const settings = await ensureGlobalSettings();

      // Build data depending on server type
      const isStdio = server.type === 'stdio';
      const env = isStdio ? (server.env ?? {}) : {};
      const processedEnv = Object.keys(env).length > 0 ? encryptMcpEnv(env) : null;
      const headers = !isStdio ? (server.headers ?? {}) : {};
      const processedHeaders = Object.keys(headers).length > 0 ? encryptMcpEnv(headers) : null;

      const data = {
        type: server.type,
        command: isStdio ? server.command : '',
        args: isStdio && server.args ? JSON.stringify(server.args) : null,
        env: processedEnv ? JSON.stringify(processedEnv) : null,
        url: !isStdio ? server.url : null,
        headers: processedHeaders ? JSON.stringify(processedHeaders) : null,
      };

      await prisma.globalMcpServer.upsert({
        where: {
          globalSettingsId_name: {
            globalSettingsId: settings.id,
            name: server.name,
          },
        },
        create: {
          globalSettingsId: settings.id,
          name: server.name,
          ...data,
        },
        update: data,
      });

      log.info('Set global MCP server', {
        name: server.name,
        type: server.type,
      });

      return { success: true };
    }),

  /**
   * Delete a global MCP server configuration
   */
  deleteMcpServer: protectedProcedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const settings = await prisma.globalSettings.findUnique({
        where: { id: GLOBAL_SETTINGS_ID },
      });

      if (settings) {
        await prisma.globalMcpServer.deleteMany({
          where: {
            globalSettingsId: settings.id,
            name: input.name,
          },
        });

        log.info('Deleted global MCP server', { name: input.name });
      }

      return { success: true };
    }),
});
