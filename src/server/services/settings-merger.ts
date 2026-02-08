import type { ContainerEnvVar, ContainerMcpServer } from './repo-settings';

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
