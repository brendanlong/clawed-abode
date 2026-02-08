import { prisma } from '@/lib/prisma';
import { decryptEnvVarsForContainer, decryptMcpServersForContainer } from './settings-helpers';
import type { ContainerEnvVar, ContainerMcpServer } from './repo-settings';

// The singleton ID for global settings
const GLOBAL_SETTINGS_ID = 'global';

/**
 * Global settings for use in Claude sessions
 */
export interface GlobalSystemPromptSettings {
  systemPromptOverride: string | null;
  systemPromptOverrideEnabled: boolean;
  systemPromptAppend: string | null;
}

/**
 * Global settings including env vars and MCP servers for container creation
 */
export interface GlobalContainerSettings extends GlobalSystemPromptSettings {
  envVars: ContainerEnvVar[];
  mcpServers: ContainerMcpServer[];
}

/**
 * Get global settings for use in Claude sessions
 * Returns defaults if no settings exist
 */
export async function getGlobalSettings(): Promise<GlobalSystemPromptSettings> {
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
}

/**
 * Get global settings including decrypted env vars and MCP servers for container creation.
 * Global env vars and MCP servers are rows where repoSettingsId IS NULL.
 */
export async function getGlobalSettingsForContainer(): Promise<GlobalContainerSettings> {
  const [settings, envVarRows, mcpServerRows] = await Promise.all([
    prisma.globalSettings.findUnique({
      where: { id: GLOBAL_SETTINGS_ID },
    }),
    prisma.envVar.findMany({ where: { repoSettingsId: null } }),
    prisma.mcpServer.findMany({ where: { repoSettingsId: null } }),
  ]);

  return {
    systemPromptOverride: settings?.systemPromptOverride ?? null,
    systemPromptOverrideEnabled: settings?.systemPromptOverrideEnabled ?? false,
    systemPromptAppend: settings?.systemPromptAppend ?? null,
    envVars: decryptEnvVarsForContainer(envVarRows),
    mcpServers: decryptMcpServersForContainer(mcpServerRows),
  };
}
