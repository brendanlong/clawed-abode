import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { encrypt, decrypt } from '@/lib/crypto';
import { TRPCError } from '@trpc/server';
import { createLogger } from '@/lib/logger';
import { DEFAULT_SYSTEM_PROMPT } from '../services/claude-runner';
import {
  envVarNameSchema,
  envVarSchema,
  mcpServerSchema,
  requireEncryptionForSecrets,
  formatEnvVarsForDisplay,
  formatMcpServersForDisplay,
  buildMcpServerData,
  mcpServerHasSecrets,
  type DisplayMcpServer,
} from '../services/settings-helpers';

const log = createLogger('globalSettings');

// The singleton ID for global settings
const GLOBAL_SETTINGS_ID = 'global';

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
   * Get global env vars and MCP servers (masked secrets)
   * Global = rows where repoSettingsId IS NULL
   */
  getWithSettings: protectedProcedure.query(async () => {
    await ensureGlobalSettings();

    const [envVars, mcpServers] = await Promise.all([
      prisma.envVar.findMany({ where: { repoSettingsId: null } }),
      prisma.mcpServer.findMany({ where: { repoSettingsId: null } }),
    ]);

    return {
      envVars: formatEnvVarsForDisplay(envVars),
      mcpServers: formatMcpServersForDisplay(mcpServers) as DisplayMcpServer[],
    };
  }),

  /**
   * Set (create or update) a global environment variable
   * Global env vars have repoSettingsId = null
   */
  setEnvVar: protectedProcedure
    .input(z.object({ envVar: envVarSchema }))
    .mutation(async ({ input }) => {
      requireEncryptionForSecrets(input.envVar.isSecret);

      // Find existing global env var with this name (repoSettingsId IS NULL)
      const existing = await prisma.envVar.findFirst({
        where: { repoSettingsId: null, name: input.envVar.name },
      });

      // If secret value is empty and existing is also secret, preserve existing encrypted value
      let value: string;
      if (input.envVar.isSecret && !input.envVar.value && existing?.isSecret) {
        value = existing.value;
      } else {
        value = input.envVar.isSecret ? encrypt(input.envVar.value) : input.envVar.value;
      }

      if (existing) {
        await prisma.envVar.update({
          where: { id: existing.id },
          data: { value, isSecret: input.envVar.isSecret },
        });
      } else {
        await prisma.envVar.create({
          data: {
            name: input.envVar.name,
            value,
            isSecret: input.envVar.isSecret,
            // repoSettingsId left null = global
          },
        });
      }

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
      await prisma.envVar.deleteMany({
        where: { repoSettingsId: null, name: input.name },
      });

      log.info('Deleted global env var', { name: input.name });

      return { success: true };
    }),

  /**
   * Get the decrypted value of a secret global environment variable
   */
  getEnvVarValue: protectedProcedure
    .input(z.object({ name: envVarNameSchema }))
    .query(async ({ input }) => {
      const envVar = await prisma.envVar.findFirst({
        where: { repoSettingsId: null, name: input.name },
      });

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
   * Global MCP servers have repoSettingsId = null
   */
  setMcpServer: protectedProcedure
    .input(z.object({ mcpServer: mcpServerSchema }))
    .mutation(async ({ input }) => {
      const server = input.mcpServer;
      requireEncryptionForSecrets(mcpServerHasSecrets(server));

      // Find existing global MCP server with this name (repoSettingsId IS NULL)
      const existing = await prisma.mcpServer.findFirst({
        where: { repoSettingsId: null, name: server.name },
      });

      const data = buildMcpServerData(server, existing);

      if (existing) {
        await prisma.mcpServer.update({
          where: { id: existing.id },
          data,
        });
      } else {
        await prisma.mcpServer.create({
          data: {
            name: server.name,
            ...data,
            // repoSettingsId left null = global
          },
        });
      }

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
      await prisma.mcpServer.deleteMany({
        where: { repoSettingsId: null, name: input.name },
      });

      log.info('Deleted global MCP server', { name: input.name });

      return { success: true };
    }),
});
