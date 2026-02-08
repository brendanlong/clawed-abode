import { prisma } from '@/lib/prisma';
import { decryptEnvVarsForContainer, decryptMcpServersForContainer } from './settings-helpers';

/**
 * Environment variable for container
 */
export interface ContainerEnvVar {
  name: string;
  value: string; // Decrypted
}

/**
 * MCP server type discriminator
 */
export type McpServerType = 'stdio' | 'http' | 'sse';

/**
 * Stdio MCP server configuration for container
 */
export interface ContainerStdioMcpServer {
  name: string;
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>; // Decrypted env values
}

/**
 * HTTP MCP server configuration for container
 */
export interface ContainerHttpMcpServer {
  name: string;
  type: 'http';
  url: string;
  headers?: Record<string, string>; // Decrypted header values
}

/**
 * SSE MCP server configuration for container
 */
export interface ContainerSseMcpServer {
  name: string;
  type: 'sse';
  url: string;
  headers?: Record<string, string>; // Decrypted header values
}

/**
 * MCP server configuration for container (discriminated union)
 */
export type ContainerMcpServer =
  | ContainerStdioMcpServer
  | ContainerHttpMcpServer
  | ContainerSseMcpServer;

/**
 * Repo settings ready for container creation
 */
export interface ContainerRepoSettings {
  customSystemPrompt: string | null;
  envVars: ContainerEnvVar[];
  mcpServers: ContainerMcpServer[];
}

/**
 * Get decrypted repo settings for use in container creation
 * Returns null if no settings exist for the repo
 */
export async function getRepoSettingsForContainer(
  repoFullName: string
): Promise<ContainerRepoSettings | null> {
  const settings = await prisma.repoSettings.findUnique({
    where: { repoFullName },
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
}
