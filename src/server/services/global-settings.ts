import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';
import { decryptEnvVarsForContainer, decryptMcpServersForContainer } from './settings-helpers';
import type { ContainerEnvVar, ContainerMcpServer } from './repo-settings';

// The singleton ID for global settings
const GLOBAL_SETTINGS_ID = 'global';

/**
 * Global settings for display in the UI (no secrets exposed)
 */
export interface GlobalDisplaySettings {
  systemPromptOverride: string | null;
  systemPromptOverrideEnabled: boolean;
  systemPromptAppend: string | null;
  claudeModel: string | null;
  hasClaudeApiKey: boolean;
}

/**
 * Global settings for use in Claude sessions (prompt building)
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
  claudeModel: string | null;
  claudeApiKey: string | null;
  envVars: ContainerEnvVar[];
  mcpServers: ContainerMcpServer[];
}

/**
 * Get global settings for display in the UI.
 * Does not expose secret values.
 */
export async function getGlobalSettings(): Promise<GlobalDisplaySettings> {
  const settings = await prisma.globalSettings.findUnique({
    where: { id: GLOBAL_SETTINGS_ID },
  });

  if (!settings) {
    return {
      systemPromptOverride: null,
      systemPromptOverrideEnabled: false,
      systemPromptAppend: null,
      claudeModel: null,
      hasClaudeApiKey: false,
    };
  }

  return {
    systemPromptOverride: settings.systemPromptOverride,
    systemPromptOverrideEnabled: settings.systemPromptOverrideEnabled,
    systemPromptAppend: settings.systemPromptAppend,
    claudeModel: settings.claudeModel,
    hasClaudeApiKey: settings.claudeApiKey !== null,
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

  // Decrypt the API key if stored
  let claudeApiKey: string | null = null;
  if (settings?.claudeApiKey) {
    claudeApiKey = decrypt(settings.claudeApiKey);
  }

  return {
    systemPromptOverride: settings?.systemPromptOverride ?? null,
    systemPromptOverrideEnabled: settings?.systemPromptOverrideEnabled ?? false,
    systemPromptAppend: settings?.systemPromptAppend ?? null,
    claudeModel: settings?.claudeModel ?? null,
    claudeApiKey,
    envVars: decryptEnvVarsForContainer(envVarRows),
    mcpServers: decryptMcpServersForContainer(mcpServerRows),
  };
}
