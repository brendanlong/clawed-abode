import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import { repoSettingsKeySchema } from '@/lib/repo-full-name';
import { nullableModelSchema, nullableTextSchema } from '../services/settings-helpers';
import { listScopeSettings } from '../services/settings-scope';
import { scopedSettingsProcedures, type ResolveScope } from './scoped-settings';

const log = createLogger('repoSettings');

const repoScopeInput = z.object({ repoFullName: repoSettingsKeySchema });

const repoSettingsUpdateSchema = repoScopeInput.extend({
  isFavorite: z.boolean().optional(),
  /** Appended to the system prompt for this repo's sessions. */
  customSystemPrompt: nullableTextSchema(10000).optional(),
  /** Overrides the global Claude model. */
  claudeModel: nullableModelSchema.optional(),
});

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
      select: { id: true, isFavorite: true, customSystemPrompt: true, claudeModel: true },
    });
    if (!settings) return null;
    const { id, ...fields } = settings;
    return { ...fields, ...(await listScopeSettings({ repoSettingsId: id })) };
  }),

  /**
   * Set any subset of the repo's plain settings, creating its row on first use;
   * omitted fields are untouched. A null or blank prompt or model reverts to the global one.
   */
  update: protectedProcedure
    .input(repoSettingsUpdateSchema)
    .mutation(async ({ input: { repoFullName, ...fields } }) => {
      await prisma.repoSettings.upsert({
        where: { repoFullName },
        create: { repoFullName, ...fields },
        update: fields,
      });
      // Field names only: the prompt can be long.
      log.info('Updated repo settings', { repoFullName, fields: Object.keys(fields) });
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
      select: {
        id: true,
        repoFullName: true,
        isFavorite: true,
        _count: { select: { envVars: true, mcpServers: true } },
      },
      orderBy: [{ isFavorite: 'desc' }, { updatedAt: 'desc' }],
    });

    return {
      settings: settings.map((s) => ({
        id: s.id,
        repoFullName: s.repoFullName,
        isFavorite: s.isFavorite,
        envVarCount: s._count.envVars,
        mcpServerCount: s._count.mcpServers,
      })),
    };
  }),

  ...scopedSettingsProcedures(repoScopeInput, resolveRepoScope),

  /** Delete all settings for a repository (env vars and MCP servers cascade). */
  delete: protectedProcedure.input(repoScopeInput).mutation(async ({ input }) => {
    await prisma.repoSettings.deleteMany({ where: { repoFullName: input.repoFullName } });
    log.info('Deleted repo settings', input);
  }),
});
