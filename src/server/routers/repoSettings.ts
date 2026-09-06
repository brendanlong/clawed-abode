import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import {
  formatEnvVarsForDisplay,
  formatMcpServersForDisplay,
  nullableTextSchema,
} from '../services/settings-helpers';
import { scopedSettingsProcedures, type ResolveScope } from './scoped-settings';

const log = createLogger('repoSettings');

const repoFullNameSchema = z.string().regex(/^(?:__no_repo__|[\w.-]+\/[\w.-]+)$/, {
  message: 'Invalid repository name format. Expected "owner/repo" or "__no_repo__"',
});

const repoScopeInput = z.object({ repoFullName: repoFullNameSchema });

/** Writes create the RepoSettings row on first use; reads leave a missing repo missing. */
const resolveRepoScope: ResolveScope<z.infer<typeof repoScopeInput>> = async (input, mode) => {
  const settings =
    mode === 'write'
      ? await prisma.repoSettings.upsert({
          where: { repoFullName: input.repoFullName },
          create: { repoFullName: input.repoFullName },
          update: {},
          select: { id: true },
        })
      : await prisma.repoSettings.findUnique({
          where: { repoFullName: input.repoFullName },
          select: { id: true },
        });
  return settings ? { repoSettingsId: settings.id } : null;
};

export const repoSettingsRouter = router({
  /** Settings for one repository with secrets masked, or null if none exist. */
  get: protectedProcedure.input(repoScopeInput).query(async ({ input }) => {
    const settings = await prisma.repoSettings.findUnique({
      where: { repoFullName: input.repoFullName },
      include: {
        envVars: { orderBy: { name: 'asc' } },
        mcpServers: { orderBy: { name: 'asc' } },
      },
    });
    if (!settings) return null;

    return {
      id: settings.id,
      repoFullName: settings.repoFullName,
      isFavorite: settings.isFavorite,
      customSystemPrompt: settings.customSystemPrompt,
      claudeModel: settings.claudeModel,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
      envVars: formatEnvVarsForDisplay(settings.envVars),
      mcpServers: formatMcpServersForDisplay(settings.mcpServers),
    };
  }),

  toggleFavorite: protectedProcedure
    .input(repoScopeInput.extend({ isFavorite: z.boolean() }))
    .mutation(async ({ input }) => {
      const settings = await prisma.repoSettings.upsert({
        where: { repoFullName: input.repoFullName },
        create: { repoFullName: input.repoFullName, isFavorite: input.isFavorite },
        update: { isFavorite: input.isFavorite },
      });
      log.info('Toggled favorite', input);
      return { isFavorite: settings.isFavorite };
    }),

  /** Per-repo prompt appended to the system prompt; null/blank clears it. */
  setCustomSystemPrompt: protectedProcedure
    .input(repoScopeInput.extend({ customSystemPrompt: nullableTextSchema(10000) }))
    .mutation(async ({ input }) => {
      await prisma.repoSettings.upsert({
        where: { repoFullName: input.repoFullName },
        create: input,
        update: { customSystemPrompt: input.customSystemPrompt },
      });
      log.info('Set custom system prompt', {
        repoFullName: input.repoFullName,
        hasPrompt: input.customSystemPrompt !== null,
      });
      return { success: true };
    }),

  /** Per-repo Claude model override; null/blank reverts to global/env. */
  setClaudeModel: protectedProcedure
    .input(repoScopeInput.extend({ claudeModel: nullableTextSchema(200) }))
    .mutation(async ({ input }) => {
      await prisma.repoSettings.upsert({
        where: { repoFullName: input.repoFullName },
        create: input,
        update: { claudeModel: input.claudeModel },
      });
      log.info('Set repo Claude model', {
        repoFullName: input.repoFullName,
        hasModel: input.claudeModel !== null,
      });
      return { success: true };
    }),

  listFavorites: protectedProcedure.query(async () => {
    const favorites = await prisma.repoSettings.findMany({
      where: { isFavorite: true },
      select: { repoFullName: true },
      orderBy: { repoFullName: 'asc' },
    });
    return { favorites: favorites.map((f) => f.repoFullName) };
  }),

  /** Every repository with settings, summarized for the settings page. */
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
        claudeModel: s.claudeModel,
        envVarCount: s.envVars.length,
        mcpServerCount: s.mcpServers.length,
        envVars: s.envVars,
        mcpServers: s.mcpServers,
        updatedAt: s.updatedAt,
      })),
    };
  }),

  ...scopedSettingsProcedures(repoScopeInput, resolveRepoScope),

  /** Delete all settings for a repository (env vars and MCP servers cascade). */
  delete: protectedProcedure.input(repoScopeInput).mutation(async ({ input }) => {
    await prisma.repoSettings.deleteMany({ where: { repoFullName: input.repoFullName } });
    log.info('Deleted repo settings', input);
    return { success: true };
  }),
});
