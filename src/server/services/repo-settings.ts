import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';

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

  // Decrypt env var values
  const envVars: ContainerEnvVar[] = settings.envVars.map((ev) => ({
    name: ev.name,
    value: ev.isSecret ? decrypt(ev.value) : ev.value,
  }));

  // Parse and decrypt MCP server configs
  const mcpServers: ContainerMcpServer[] = settings.mcpServers.map((mcp) => {
    const serverType = (mcp.type || 'stdio') as McpServerType;

    if (serverType === 'http' || serverType === 'sse') {
      // HTTP/SSE servers: decrypt headers
      const headersJson = mcp.headers
        ? (JSON.parse(mcp.headers) as Record<string, { value: string; isSecret: boolean }>)
        : {};
      const headers = Object.fromEntries(
        Object.entries(headersJson).map(([key, { value, isSecret }]) => [
          key,
          isSecret ? decrypt(value) : value,
        ])
      );

      return {
        name: mcp.name,
        type: serverType,
        url: mcp.url!,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      } as ContainerMcpServer;
    }

    // Stdio servers: decrypt env vars
    const envJson = mcp.env
      ? (JSON.parse(mcp.env) as Record<string, { value: string; isSecret: boolean }>)
      : {};
    const env = Object.fromEntries(
      Object.entries(envJson).map(([key, { value, isSecret }]) => [
        key,
        isSecret ? decrypt(value) : value,
      ])
    );

    return {
      name: mcp.name,
      type: 'stdio',
      command: mcp.command,
      args: mcp.args ? (JSON.parse(mcp.args) as string[]) : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
    } as ContainerStdioMcpServer;
  });

  return {
    customSystemPrompt: settings.customSystemPrompt,
    envVars,
    mcpServers,
  };
}
