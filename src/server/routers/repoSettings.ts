import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { encrypt, decrypt } from '@/lib/crypto';
import { TRPCError } from '@trpc/server';
import { createLogger } from '@/lib/logger';
import {
  envVarNameSchema,
  envVarSchema,
  mcpServerSchema,
  requireEncryptionForSecrets,
  formatEnvVarsForDisplay,
  formatMcpServersForDisplay,
  buildMcpServerData,
  mcpServerHasSecrets,
  decryptEnvVarsForContainer,
  decryptMcpServersForContainer,
} from '../services/settings-helpers';
import { validateMcpServer } from '../services/mcp-validator';

const log = createLogger('repoSettings');

const repoFullNameSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/, {
  message: 'Invalid repository name format. Expected "owner/repo"',
});

export const repoSettingsRouter = router({
  /**
   * Get settings for a specific repository
   * Returns null if no settings exist
   */
  get: protectedProcedure
    .input(z.object({ repoFullName: repoFullNameSchema }))
    .query(async ({ input }) => {
      const settings = await prisma.repoSettings.findUnique({
        where: { repoFullName: input.repoFullName },
        include: { envVars: true, mcpServers: true },
      });

      if (!settings) {
        return null;
      }

      // Mask secret values for display
      return {
        id: settings.id,
        repoFullName: settings.repoFullName,
        isFavorite: settings.isFavorite,
        displayOrder: settings.displayOrder,
        customSystemPrompt: settings.customSystemPrompt,
        createdAt: settings.createdAt,
        updatedAt: settings.updatedAt,
        envVars: formatEnvVarsForDisplay(settings.envVars),
        mcpServers: formatMcpServersForDisplay(settings.mcpServers),
      };
    }),

  /**
   * Toggle favorite status for a repository
   */
  toggleFavorite: protectedProcedure
    .input(
      z.object({
        repoFullName: repoFullNameSchema,
        isFavorite: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      const settings = await prisma.repoSettings.upsert({
        where: { repoFullName: input.repoFullName },
        create: {
          repoFullName: input.repoFullName,
          isFavorite: input.isFavorite,
        },
        update: { isFavorite: input.isFavorite },
      });

      log.info('Toggled favorite', {
        repoFullName: input.repoFullName,
        isFavorite: input.isFavorite,
      });

      return { isFavorite: settings.isFavorite };
    }),

  /**
   * Set custom system prompt for a repository
   * Pass null or empty string to clear
   */
  setCustomSystemPrompt: protectedProcedure
    .input(
      z.object({
        repoFullName: repoFullNameSchema,
        customSystemPrompt: z.string().max(10000).nullable(),
      })
    )
    .mutation(async ({ input }) => {
      const prompt = input.customSystemPrompt?.trim() || null;

      await prisma.repoSettings.upsert({
        where: { repoFullName: input.repoFullName },
        create: {
          repoFullName: input.repoFullName,
          customSystemPrompt: prompt,
        },
        update: { customSystemPrompt: prompt },
      });

      log.info('Set custom system prompt', {
        repoFullName: input.repoFullName,
        hasPrompt: prompt !== null,
      });

      return { success: true };
    }),

  /**
   * List all favorite repository names
   */
  listFavorites: protectedProcedure.query(async () => {
    const favorites = await prisma.repoSettings.findMany({
      where: { isFavorite: true },
      select: { repoFullName: true },
      orderBy: [{ displayOrder: 'asc' }, { repoFullName: 'asc' }],
    });

    return { favorites: favorites.map((f) => f.repoFullName) };
  }),

  /**
   * List all repositories with settings (for settings page)
   */
  listWithSettings: protectedProcedure.query(async () => {
    const settings = await prisma.repoSettings.findMany({
      include: {
        envVars: { select: { id: true, name: true, isSecret: true } },
        mcpServers: { select: { id: true, name: true } },
      },
      orderBy: [{ isFavorite: 'desc' }, { updatedAt: 'desc' }],
    });

    return {
      settings: settings.map((s) => ({
        id: s.id,
        repoFullName: s.repoFullName,
        isFavorite: s.isFavorite,
        customSystemPrompt: s.customSystemPrompt,
        envVarCount: s.envVars.length,
        mcpServerCount: s.mcpServers.length,
        envVars: s.envVars,
        mcpServers: s.mcpServers,
        updatedAt: s.updatedAt,
      })),
    };
  }),

  /**
   * Set (create or update) an environment variable
   */
  setEnvVar: protectedProcedure
    .input(
      z.object({
        repoFullName: repoFullNameSchema,
        envVar: envVarSchema,
      })
    )
    .mutation(async ({ input }) => {
      requireEncryptionForSecrets(input.envVar.isSecret);

      // Ensure RepoSettings exists
      const settings = await prisma.repoSettings.upsert({
        where: { repoFullName: input.repoFullName },
        create: { repoFullName: input.repoFullName },
        update: {},
      });

      // Check if existing value should be preserved (secret unchanged)
      const existing = await prisma.envVar.findUnique({
        where: {
          repoSettingsId_name: {
            repoSettingsId: settings.id,
            name: input.envVar.name,
          },
        },
      });

      let value: string;
      if (input.envVar.isSecret && !input.envVar.value && existing?.isSecret) {
        value = existing.value;
      } else {
        value = input.envVar.isSecret ? encrypt(input.envVar.value) : input.envVar.value;
      }

      await prisma.envVar.upsert({
        where: {
          repoSettingsId_name: {
            repoSettingsId: settings.id,
            name: input.envVar.name,
          },
        },
        create: {
          repoSettingsId: settings.id,
          name: input.envVar.name,
          value,
          isSecret: input.envVar.isSecret,
        },
        update: {
          value,
          isSecret: input.envVar.isSecret,
        },
      });

      log.info('Set env var', {
        repoFullName: input.repoFullName,
        name: input.envVar.name,
        isSecret: input.envVar.isSecret,
      });

      return { success: true };
    }),

  /**
   * Delete an environment variable
   */
  deleteEnvVar: protectedProcedure
    .input(
      z.object({
        repoFullName: repoFullNameSchema,
        name: envVarNameSchema,
      })
    )
    .mutation(async ({ input }) => {
      const settings = await prisma.repoSettings.findUnique({
        where: { repoFullName: input.repoFullName },
      });

      if (settings) {
        await prisma.envVar.deleteMany({
          where: {
            repoSettingsId: settings.id,
            name: input.name,
          },
        });

        log.info('Deleted env var', { repoFullName: input.repoFullName, name: input.name });
      }

      return { success: true };
    }),

  /**
   * Set (create or update) an MCP server configuration
   */
  setMcpServer: protectedProcedure
    .input(
      z.object({
        repoFullName: repoFullNameSchema,
        mcpServer: mcpServerSchema,
      })
    )
    .mutation(async ({ input }) => {
      const server = input.mcpServer;
      requireEncryptionForSecrets(mcpServerHasSecrets(server));

      // Ensure RepoSettings exists
      const settings = await prisma.repoSettings.upsert({
        where: { repoFullName: input.repoFullName },
        create: { repoFullName: input.repoFullName },
        update: {},
      });

      // Find existing to preserve unchanged secrets
      const existing = await prisma.mcpServer.findUnique({
        where: {
          repoSettingsId_name: {
            repoSettingsId: settings.id,
            name: server.name,
          },
        },
      });

      const data = buildMcpServerData(server, existing);

      await prisma.mcpServer.upsert({
        where: {
          repoSettingsId_name: {
            repoSettingsId: settings.id,
            name: server.name,
          },
        },
        create: {
          repoSettingsId: settings.id,
          name: server.name,
          ...data,
        },
        update: data,
      });

      log.info('Set MCP server', {
        repoFullName: input.repoFullName,
        name: server.name,
        type: server.type,
      });

      return { success: true };
    }),

  /**
   * Delete an MCP server configuration
   */
  deleteMcpServer: protectedProcedure
    .input(
      z.object({
        repoFullName: repoFullNameSchema,
        name: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const settings = await prisma.repoSettings.findUnique({
        where: { repoFullName: input.repoFullName },
      });

      if (settings) {
        await prisma.mcpServer.deleteMany({
          where: {
            repoSettingsId: settings.id,
            name: input.name,
          },
        });

        log.info('Deleted MCP server', { repoFullName: input.repoFullName, name: input.name });
      }

      return { success: true };
    }),

  /**
   * Get the decrypted value of a secret environment variable
   * Used when user clicks "reveal" button in UI
   */
  getEnvVarValue: protectedProcedure
    .input(
      z.object({
        repoFullName: repoFullNameSchema,
        name: envVarNameSchema,
      })
    )
    .query(async ({ input }) => {
      const settings = await prisma.repoSettings.findUnique({
        where: { repoFullName: input.repoFullName },
        include: { envVars: true },
      });

      if (!settings) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Repository settings not found',
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
   * Delete all settings for a repository
   */
  delete: protectedProcedure
    .input(z.object({ repoFullName: repoFullNameSchema }))
    .mutation(async ({ input }) => {
      await prisma.repoSettings.deleteMany({
        where: { repoFullName: input.repoFullName },
      });

      log.info('Deleted repo settings', { repoFullName: input.repoFullName });

      return { success: true };
    }),

  /**
   * Validate an MCP server connection by connecting with the MCP SDK
   * Only works for HTTP/SSE servers (stdio servers run inside containers)
   */
  validateMcpServer: protectedProcedure
    .input(
      z.object({
        repoFullName: repoFullNameSchema,
        name: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const settings = await prisma.repoSettings.findUnique({
        where: { repoFullName: input.repoFullName },
        include: { mcpServers: true },
      });

      if (!settings) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Repository settings not found',
        });
      }

      const dbServer = settings.mcpServers.find((s) => s.name === input.name);
      if (!dbServer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `MCP server "${input.name}" not found`,
        });
      }

      const [decrypted] = decryptMcpServersForContainer([dbServer]);
      return validateMcpServer(decrypted);
    }),

  /**
   * Get decrypted settings for container creation (internal use)
   * This is exported separately for use by the container creation service
   */
  getForContainer: protectedProcedure
    .input(z.object({ repoFullName: repoFullNameSchema }))
    .query(async ({ input }) => {
      const settings = await prisma.repoSettings.findUnique({
        where: { repoFullName: input.repoFullName },
        include: { envVars: true, mcpServers: true },
      });

      if (!settings) {
        return null;
      }

      return {
        customSystemPrompt: settings.customSystemPrompt,
        envVars: decryptEnvVarsForContainer(settings.envVars),
        mcpServers: decryptMcpServersForContainer(settings.mcpServers),
      };
    }),
});
