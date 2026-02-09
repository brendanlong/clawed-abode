import type { ContainerEnvVar, ContainerMcpServer } from './repo-settings';
import { getRepoSettingsForContainer } from './repo-settings';
import { getGlobalSettingsForContainer, type GlobalContainerSettings } from './global-settings';
import { buildSystemPrompt } from './claude-runner';

/**
 * Merge global and per-repo environment variables.
 * Per-repo env vars take precedence over global ones with the same name.
 */
export function mergeEnvVars(
  globalEnvVars: ContainerEnvVar[],
  repoEnvVars: ContainerEnvVar[]
): ContainerEnvVar[] {
  const merged = new Map<string, ContainerEnvVar>();

  // Add global env vars first
  for (const envVar of globalEnvVars) {
    merged.set(envVar.name, envVar);
  }

  // Per-repo env vars override global ones
  for (const envVar of repoEnvVars) {
    merged.set(envVar.name, envVar);
  }

  return Array.from(merged.values());
}

/**
 * Merge global and per-repo MCP servers.
 * Per-repo MCP servers take precedence over global ones with the same name.
 */
export function mergeMcpServers(
  globalMcpServers: ContainerMcpServer[],
  repoMcpServers: ContainerMcpServer[]
): ContainerMcpServer[] {
  const merged = new Map<string, ContainerMcpServer>();

  // Add global MCP servers first
  for (const server of globalMcpServers) {
    merged.set(server.name, server);
  }

  // Per-repo MCP servers override global ones
  for (const server of repoMcpServers) {
    merged.set(server.name, server);
  }

  return Array.from(merged.values());
}

/**
 * Merged session settings ready for container creation and Claude queries.
 */
export interface MergedSessionSettings {
  systemPrompt: string;
  envVars: ContainerEnvVar[];
  mcpServers: ContainerMcpServer[];
  claudeModel: string | undefined;
  claudeApiKey: string | undefined;
  /** Raw global settings, preserved for callers that need prompt fields individually */
  globalSettings: GlobalContainerSettings;
  /** Per-repo custom system prompt, preserved for callers that pass it separately */
  customSystemPrompt: string | null;
}

/**
 * Load and merge global + per-repo settings for a session.
 * Fetches both in parallel, builds the system prompt, and merges env vars and MCP servers.
 *
 * @param repoFullName - The "owner/repo" string identifying the repository.
 *                       When null/undefined, only global settings are used.
 */
export async function loadMergedSessionSettings(
  repoFullName: string | null | undefined
): Promise<MergedSessionSettings> {
  const [repoSettings, globalSettings] = await Promise.all([
    repoFullName ? getRepoSettingsForContainer(repoFullName) : null,
    getGlobalSettingsForContainer(),
  ]);

  const systemPrompt = buildSystemPrompt({
    customSystemPrompt: repoSettings?.customSystemPrompt,
    globalSettings,
  });

  const envVars = mergeEnvVars(globalSettings.envVars, repoSettings?.envVars ?? []);
  const mcpServers = mergeMcpServers(globalSettings.mcpServers, repoSettings?.mcpServers ?? []);

  return {
    systemPrompt,
    envVars,
    mcpServers,
    claudeModel: globalSettings.claudeModel ?? undefined,
    claudeApiKey: globalSettings.claudeApiKey ?? undefined,
    globalSettings,
    customSystemPrompt: repoSettings?.customSystemPrompt ?? null,
  };
}
