import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';
import type { ContainerEnvVar, ContainerMcpServer, McpServerType } from './repo-settings';

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
 * This returns everything needed to configure a container.
 */
export async function getGlobalSettingsForContainer(): Promise<GlobalContainerSettings> {
  const settings = await prisma.globalSettings.findUnique({
    where: { id: GLOBAL_SETTINGS_ID },
    include: { envVars: true, mcpServers: true },
  });

  if (!settings) {
    return {
      systemPromptOverride: null,
      systemPromptOverrideEnabled: false,
      systemPromptAppend: null,
      envVars: [],
      mcpServers: [],
    };
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
      type: 'stdio' as const,
      command: mcp.command,
      args: mcp.args ? (JSON.parse(mcp.args) as string[]) : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
    };
  });

  return {
    systemPromptOverride: settings.systemPromptOverride,
    systemPromptOverrideEnabled: settings.systemPromptOverrideEnabled,
    systemPromptAppend: settings.systemPromptAppend,
    envVars,
    mcpServers,
  };
}
