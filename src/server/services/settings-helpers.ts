import { z } from 'zod';
import { encrypt, decrypt, isEncryptionConfigured } from '@/lib/crypto';
import { TRPCError } from '@trpc/server';
import type {
  McpAuthType,
  McpOAuthStatus,
  McpServerType,
  ResolvedEnvVar,
  ResolvedMcpServer,
} from '@/lib/settings-types';
import { formatOAuthStatus, type McpOAuthTokenSnapshot, type OAuthStatusRow } from './mcp-oauth';

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

const mcpServerEnvValueSchema = z.object({
  value: z.string(),
  isSecret: z.boolean().default(false),
});

export type McpServerEnvValue = z.infer<typeof mcpServerEnvValueSchema>;

const mcpServerEnvSchema = z.record(z.string(), mcpServerEnvValueSchema);

const mcpServerStdioSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.literal('stdio').default('stdio'),
  command: z.string().min(1).max(1000),
  args: z.array(z.string()).optional(),
  env: mcpServerEnvSchema.optional(),
});

/**
 * OAuth client configuration the user can supply by hand — the escape hatch for
 * servers with no dynamic client registration (Google and Microsoft Entra have
 * none at all). Blank fields mean "discover it"; a blank secret on an existing
 * server means "unchanged", matching every other secret field.
 */
const mcpOAuthConfigSchema = z.object({
  clientId: z.string().max(500).default(''),
  clientSecret: z.string().max(2000).default(''),
  scope: z.string().max(1000).default(''),
});

export type McpOAuthConfigInput = z.infer<typeof mcpOAuthConfigSchema>;

const mcpServerHttpSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['http', 'sse']),
  url: z.string().url().max(2000),
  headers: mcpServerEnvSchema.optional(),
  authType: z.enum(['headers', 'oauth']).default('headers'),
  oauth: mcpOAuthConfigSchema.optional(),
});

export const mcpServerSchema = z.discriminatedUnion('type', [
  mcpServerStdioSchema,
  mcpServerHttpSchema,
]);

/** Free-text setting input: trimmed, with blank/null meaning "clear". */
export const nullableTextSchema = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .transform((value) => value?.trim() || null);

export type EnvVarInput = z.infer<typeof envVarSchema>;
export type McpServerInput = z.infer<typeof mcpServerSchema>;

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
function maskSecrets<T extends { value: string; isSecret: boolean }>(items: T[]): T[] {
  return items.map((item) => ({
    ...item,
    value: item.isSecret ? '••••••••' : item.value,
  }));
}

/**
 * Mask MCP server env/header secrets for display
 */
function maskMcpEnv(env: Record<string, McpServerEnvValue>): Record<string, McpServerEnvValue> {
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

/** DB row shape for MCP servers, with the OAuth row joined when there is one. */
interface DbMcpServer {
  id: string;
  name: string;
  type: string;
  command: string;
  args: string | null;
  env: string | null;
  url: string | null;
  headers: string | null;
  authType: string;
  /**
   * Required (not optional) so a query that forgets `include: { oauth: true }`
   * fails to compile: a silently-absent grant reads as "not authorized" and would
   * make the settings form clear the stored client on the next save.
   */
  oauth: (OAuthStatusRow & McpOAuthTokenSnapshot) | null;
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
  authType: McpAuthType;
  oauth?: McpOAuthStatus;
}

/**
 * Format env var DB rows for display (mask secrets)
 */
export function formatEnvVarsForDisplay(envVars: DbEnvVar[]) {
  return maskSecrets(
    envVars.map(({ id, name, value, isSecret }) => ({ id, name, value, isSecret }))
  );
}

/**
 * Format MCP server DB rows for display (mask secrets, parse JSON)
 */
export function formatMcpServersForDisplay(mcpServers: DbMcpServer[]): DisplayMcpServer[] {
  return mcpServers.map((mcp) => {
    const authType = (mcp.authType || 'headers') as McpAuthType;
    return {
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
      authType,
      ...(authType === 'oauth' ? { oauth: formatOAuthStatus(mcp.oauth) } : {}),
    };
  });
}

// ─── Decrypt for the session runner ──────────────────────────────────

export function decryptEnvVars(
  envVars: Array<{ name: string; value: string; isSecret: boolean }>
): ResolvedEnvVar[] {
  return envVars.map((ev) => ({
    name: ev.name,
    value: ev.isSecret ? decrypt(ev.value) : ev.value,
  }));
}

/**
 * Decrypt one stored `{ value, isSecret }` map (an MCP server's headers or env).
 * Returns undefined rather than `{}` so an empty column omits the field entirely.
 */
function decryptSecretRecord(json: string | null): Record<string, string> | undefined {
  if (!json) return undefined;
  const stored = JSON.parse(json) as Record<string, { value: string; isSecret: boolean }>;
  const entries = Object.entries(stored).map(([key, { value, isSecret }]): [string, string] => [
    key,
    isSecret ? decrypt(value) : value,
  ]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function decryptMcpServers(mcpServers: DbMcpServer[]): ResolvedMcpServer[] {
  return mcpServers.map((mcp) => {
    const serverType = (mcp.type || 'stdio') as McpServerType;

    if (serverType === 'http' || serverType === 'sse') {
      return {
        name: mcp.name,
        type: serverType,
        url: mcp.url!,
        headers: decryptSecretRecord(mcp.headers),
        ...(mcp.authType === 'oauth' && mcp.oauth
          ? {
              oauth: {
                id: mcp.oauth.id,
                accessToken: mcp.oauth.accessToken,
                expiresAt: mcp.oauth.expiresAt,
              },
            }
          : {}),
      };
    }

    return {
      name: mcp.name,
      type: 'stdio' as const,
      command: mcp.command,
      args: mcp.args ? (JSON.parse(mcp.args) as string[]) : undefined,
      env: decryptSecretRecord(mcp.env),
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
    authType: isStdio ? 'headers' : server.authType,
  };
}

/**
 * Check if an MCP server input has any secret values
 */
export function mcpServerHasSecrets(server: z.infer<typeof mcpServerSchema>): boolean {
  if (server.type !== 'stdio' && server.authType === 'oauth') return true;
  const secretEntries = server.type === 'stdio' ? (server.env ?? {}) : (server.headers ?? {});
  return Object.values(secretEntries).some((e) => e.isSecret);
}
