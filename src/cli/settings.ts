/**
 * Load/save glue between the database and the CLI's editable settings
 * documents. Replaces rows wholesale on save — the document is the complete
 * desired state for its scope.
 */

import { prisma } from '@/lib/prisma';
import { decrypt, encrypt } from '@/lib/crypto';
import { requireEncryptionForSecrets } from '@/server/services/settings-helpers';
import {
  globalSettingsDocSchema,
  repoSettingsDocSchema,
  envVarsToDoc,
  mcpServersToDoc,
  envVarDocToDb,
  mcpServerDocToDb,
  docHasSecrets,
  type GlobalSettingsDoc,
  type RepoSettingsDoc,
} from './settings-doc';

const GLOBAL_SETTINGS_ID = 'global';

export { globalSettingsDocSchema, repoSettingsDocSchema };
export type { GlobalSettingsDoc, RepoSettingsDoc };

export async function loadGlobalSettingsDoc(): Promise<GlobalSettingsDoc> {
  const [settings, envVars, mcpServers] = await Promise.all([
    prisma.globalSettings.findUnique({ where: { id: GLOBAL_SETTINGS_ID } }),
    prisma.envVar.findMany({ where: { repoSettingsId: null }, orderBy: { name: 'asc' } }),
    prisma.mcpServer.findMany({ where: { repoSettingsId: null }, orderBy: { name: 'asc' } }),
  ]);

  return {
    claudeModel: settings?.claudeModel ?? null,
    claudeApiKey: settings?.claudeApiKey ? decrypt(settings.claudeApiKey) : null,
    systemPromptOverrideEnabled: settings?.systemPromptOverrideEnabled ?? false,
    systemPromptOverride: settings?.systemPromptOverride ?? null,
    systemPromptAppend: settings?.systemPromptAppend ?? null,
    envVars: envVarsToDoc(envVars),
    mcpServers: mcpServersToDoc(mcpServers),
  };
}

export async function saveGlobalSettingsDoc(doc: GlobalSettingsDoc): Promise<void> {
  requireEncryptionForSecrets(docHasSecrets(doc) || doc.claudeApiKey !== null);

  const settingsData = {
    claudeModel: doc.claudeModel,
    claudeApiKey: doc.claudeApiKey ? encrypt(doc.claudeApiKey) : null,
    systemPromptOverrideEnabled: doc.systemPromptOverrideEnabled,
    systemPromptOverride: doc.systemPromptOverride,
    systemPromptAppend: doc.systemPromptAppend,
  };
  const envVarRows = doc.envVars.map((ev) => envVarDocToDb(ev, null));
  const mcpServerRows = doc.mcpServers.map((server) => mcpServerDocToDb(server, null));

  await prisma.$transaction([
    prisma.globalSettings.upsert({
      where: { id: GLOBAL_SETTINGS_ID },
      create: { id: GLOBAL_SETTINGS_ID, ...settingsData },
      update: settingsData,
    }),
    prisma.envVar.deleteMany({ where: { repoSettingsId: null } }),
    prisma.envVar.createMany({ data: envVarRows }),
    prisma.mcpServer.deleteMany({ where: { repoSettingsId: null } }),
    prisma.mcpServer.createMany({ data: mcpServerRows }),
  ]);
}

export async function loadRepoSettingsDoc(repoFullName: string): Promise<RepoSettingsDoc> {
  const settings = await prisma.repoSettings.findUnique({
    where: { repoFullName },
    include: {
      envVars: { orderBy: { name: 'asc' } },
      mcpServers: { orderBy: { name: 'asc' } },
    },
  });

  return {
    isFavorite: settings?.isFavorite ?? false,
    claudeModel: settings?.claudeModel ?? null,
    customSystemPrompt: settings?.customSystemPrompt ?? null,
    envVars: envVarsToDoc(settings?.envVars ?? []),
    mcpServers: mcpServersToDoc(settings?.mcpServers ?? []),
  };
}

export async function saveRepoSettingsDoc(
  repoFullName: string,
  doc: RepoSettingsDoc
): Promise<void> {
  requireEncryptionForSecrets(docHasSecrets(doc));

  const settingsData = {
    isFavorite: doc.isFavorite,
    claudeModel: doc.claudeModel,
    customSystemPrompt: doc.customSystemPrompt,
  };

  const settings = await prisma.repoSettings.upsert({
    where: { repoFullName },
    create: { repoFullName, ...settingsData },
    update: settingsData,
  });

  const envVarRows = doc.envVars.map((ev) => envVarDocToDb(ev, settings.id));
  const mcpServerRows = doc.mcpServers.map((server) => mcpServerDocToDb(server, settings.id));

  await prisma.$transaction([
    prisma.envVar.deleteMany({ where: { repoSettingsId: settings.id } }),
    prisma.envVar.createMany({ data: envVarRows }),
    prisma.mcpServer.deleteMany({ where: { repoSettingsId: settings.id } }),
    prisma.mcpServer.createMany({ data: mcpServerRows }),
  ]);
}

/** Repos that have settings rows, favorites first (for pickers and menus). */
export async function listConfiguredRepos(): Promise<
  Array<{ repoFullName: string; isFavorite: boolean }>
> {
  return prisma.repoSettings.findMany({
    select: { repoFullName: true, isFavorite: true },
    orderBy: [{ isFavorite: 'desc' }, { displayOrder: 'asc' }, { repoFullName: 'asc' }],
  });
}
