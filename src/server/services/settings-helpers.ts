import { z } from 'zod';
import { encrypt, decrypt, isEncryptionConfigured } from '@/lib/crypto';
import { TRPCError } from '@trpc/server';
import type { ContainerEnvVar, ContainerMcpServer, McpServerType } from './repo-settings';

// ─── Validation Schemas ──────────────────────────────────────────────

export const envVarNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
    message:
      'Environment variable name must start with a letter or underscore and contain only alphanumeric characters and underscores',
  });

export const envVarSchema = z.object({
  name: envVarNameSchema,
  value: z.string().max(10000),
  isSecret: z.boolean().default(false),
});

export const mcpServerEnvValueSchema = z.object({
  value: z.string(),
  isSecret: z.boolean().default(false),
});

export type McpServerEnvValue = z.infer<typeof mcpServerEnvValueSchema>;

export const mcpServerEnvSchema = z.record(z.string(), mcpServerEnvValueSchema);

export const mcpServerStdioSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.literal('stdio').default('stdio'),
  command: z.string().min(1).max(1000),
  args: z.array(z.string()).optional(),
  env: mcpServerEnvSchema.optional(),
});

export const mcpServerHttpSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['http', 'sse']),
  url: z.string().url().max(2000),
  headers: mcpServerEnvSchema.optional(),
});

export const mcpServerSchema = z.discriminatedUnion('type', [
  mcpServerStdioSchema,
  mcpServerHttpSchema,
]);

// ─── Secret Helpers ──────────────────────────────────────────────────

/**
 * Check that encryption is configured when storing secrets.
 * Throws a TRPCError if secrets are requested but encryption is not set up.
 */
export function requireEncryptionForSecrets(hasSecrets: boolean): void {
  if (hasSecrets && !isEncryptionConfigured()) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'ENCRYPTION_KEY must be configured to store secrets. See .env.example for instructions.',
    });
  }
}

/**
 * Mask secret values for display
 */
export function maskSecrets<T extends { value: string; isSecret: boolean }>(items: T[]): T[] {
  return items.map((item) => ({
    ...item,
    value: item.isSecret ? '••••••••' : item.value,
  }));
}

/**
 * Mask MCP server env/header secrets for display
 */
export function maskMcpEnv(
  env: Record<string, McpServerEnvValue>
): Record<string, McpServerEnvValue> {
  return Object.fromEntries(
    Object.entries(env).map(([key, { value, isSecret }]) => [
      key,
      { value: isSecret ? '••••••••' : value, isSecret },
    ])
  );
}

// ─── Display Formatters ──────────────────────────────────────────────

/** DB row shape for env vars */
interface DbEnvVar {
  id: string;
  name: string;
  value: string;
  isSecret: boolean;
}

/** DB row shape for MCP servers */
interface DbMcpServer {
  id: string;
  name: string;
  type: string;
  command: string;
  args: string | null;
  env: string | null;
  url: string | null;
  headers: string | null;
}

/** MCP server formatted for API responses (masked secrets) */
export interface DisplayMcpServer {
  id: string;
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command: string;
  args: string[];
  env: Record<string, McpServerEnvValue>;
  url?: string;
  headers: Record<string, McpServerEnvValue>;
}

/**
 * Format env var DB rows for display (mask secrets)
 */
export function formatEnvVarsForDisplay(envVars: DbEnvVar[]) {
  return maskSecrets(
    envVars.map((ev) => ({
      id: ev.id,
      name: ev.name,
      value: ev.value,
      isSecret: ev.isSecret,
    }))
  );
}

/**
 * Format MCP server DB rows for display (mask secrets, parse JSON)
 */
export function formatMcpServersForDisplay(mcpServers: DbMcpServer[]): DisplayMcpServer[] {
  return mcpServers.map((mcp) => ({
    id: mcp.id,
    name: mcp.name,
    type: (mcp.type || 'stdio') as 'stdio' | 'http' | 'sse',
    command: mcp.command,
    args: mcp.args ? (JSON.parse(mcp.args) as string[]) : [],
    env: mcp.env ? maskMcpEnv(JSON.parse(mcp.env) as Record<string, McpServerEnvValue>) : {},
    url: mcp.url ?? undefined,
    headers: mcp.headers
      ? maskMcpEnv(JSON.parse(mcp.headers) as Record<string, McpServerEnvValue>)
      : {},
  }));
}

// ─── Container Decrypt Functions ─────────────────────────────────────

/**
 * Decrypt env var DB rows for container creation
 */
export function decryptEnvVarsForContainer(
  envVars: Array<{ name: string; value: string; isSecret: boolean }>
): ContainerEnvVar[] {
  return envVars.map((ev) => ({
    name: ev.name,
    value: ev.isSecret ? decrypt(ev.value) : ev.value,
  }));
}

/**
 * Decrypt MCP server DB rows for container creation
 */
export function decryptMcpServersForContainer(mcpServers: DbMcpServer[]): ContainerMcpServer[] {
  return mcpServers.map((mcp) => {
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
}

// ─── MCP Server Data Builder ─────────────────────────────────────────

/**
 * Merge secret values from input with existing encrypted values from the DB.
 * When a secret value is empty, it means the user didn't change it, so we
 * preserve the existing encrypted value from the database.
 */
function mergeSecretEnv(
  input: Record<string, McpServerEnvValue>,
  existingJson: string | null
): Record<string, McpServerEnvValue> {
  const existing = existingJson
    ? (JSON.parse(existingJson) as Record<string, McpServerEnvValue>)
    : {};

  return Object.fromEntries(
    Object.entries(input).map(([key, entry]) => {
      if (entry.isSecret && !entry.value && existing[key]?.isSecret) {
        // Unchanged secret: preserve existing encrypted value
        return [key, existing[key]];
      }
      // New or changed value: encrypt if secret
      return [
        key,
        { value: entry.isSecret ? encrypt(entry.value) : entry.value, isSecret: entry.isSecret },
      ];
    })
  );
}

/** Shape of an existing MCP server DB row, used to preserve unchanged secrets */
interface ExistingMcpServer {
  env: string | null;
  headers: string | null;
}

/**
 * Build MCP server data object for database upsert from validated input.
 * When `existing` is provided, unchanged secret values (empty string + isSecret)
 * are preserved from the existing DB record rather than being overwritten.
 */
export function buildMcpServerData(
  server: z.infer<typeof mcpServerSchema>,
  existing?: ExistingMcpServer | null
) {
  const isStdio = server.type === 'stdio';
  const env = isStdio ? (server.env ?? {}) : {};
  const processedEnv =
    Object.keys(env).length > 0 ? mergeSecretEnv(env, existing?.env ?? null) : null;
  const headers = !isStdio ? (server.headers ?? {}) : {};
  const processedHeaders =
    Object.keys(headers).length > 0 ? mergeSecretEnv(headers, existing?.headers ?? null) : null;

  return {
    type: server.type,
    command: isStdio ? server.command : '',
    args: isStdio && server.args ? JSON.stringify(server.args) : null,
    env: processedEnv ? JSON.stringify(processedEnv) : null,
    url: !isStdio ? server.url : null,
    headers: processedHeaders ? JSON.stringify(processedHeaders) : null,
  };
}

/**
 * Check if an MCP server input has any secret values
 */
export function mcpServerHasSecrets(server: z.infer<typeof mcpServerSchema>): boolean {
  const secretEntries = server.type === 'stdio' ? (server.env ?? {}) : (server.headers ?? {});
  return Object.values(secretEntries).some((e) => e.isSecret);
}
