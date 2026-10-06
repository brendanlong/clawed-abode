import { z } from 'zod';
import { encrypt, decrypt, isEncryptionConfigured } from '@/lib/crypto';
import { TRPCError } from '@trpc/server';
import type { Prisma } from '@/generated/prisma/client';
import {
  mcpAuthTypeSchema,
  mcpHttpServerTypeSchema,
  type McpServer,
  type McpServerType,
  type ResolvedEnvVar,
  type ResolvedMcpServer,
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
  type: mcpHttpServerTypeSchema,
  url: z.string().url().max(2000),
  headers: mcpServerEnvSchema.optional(),
  authType: mcpAuthTypeSchema.default('headers'),
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

/** Mask a secret value for display. */
function maskSecret<T extends { value: string; isSecret: boolean }>(item: T): T {
  return { ...item, value: item.isSecret ? '••••••••' : item.value };
}

/** Which McpServerValue rows a server type uses: env vars for stdio, headers otherwise. */
export type McpServerValueKind = 'env' | 'header';

function valueKindFor(type: McpServerType): McpServerValueKind {
  return type === 'stdio' ? 'env' : 'header';
}

interface DbMcpServerValue {
  kind: string;
  name: string;
  value: string;
  isSecret: boolean;
}

/** Every MCP server query must include this so formatting and decryption see the values and grant. */
export const MCP_SERVER_INCLUDE = {
  oauth: true,
  values: { orderBy: { name: 'asc' } },
} as const satisfies Prisma.McpServerInclude;

function valuesOfKind(
  values: DbMcpServerValue[],
  kind: McpServerValueKind,
  toValue: (row: DbMcpServerValue) => string
): Record<string, string> {
  return Object.fromEntries(values.filter((v) => v.kind === kind).map((v) => [v.name, toValue(v)]));
}

function maskedValuesOfKind(
  values: DbMcpServerValue[],
  kind: McpServerValueKind
): Record<string, McpServerEnvValue> {
  return Object.fromEntries(
    values
      .filter((v) => v.kind === kind)
      .map(({ name, value, isSecret }) => [name, maskSecret({ value, isSecret })])
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
  url: string | null;
  authType: string;
  values: DbMcpServerValue[];
  /**
   * Required (not optional) so a query that forgets `include: { oauth: true }`
   * fails to compile: a silently-absent grant reads as "not authorized" and would
   * make the settings form clear the stored client on the next save.
   */
  oauth: (OAuthStatusRow & McpOAuthTokenSnapshot) | null;
}

/**
 * The stringly-typed columns of an MCP server row. Rows are only written from
 * validated input, so a mismatch means a corrupt row: throw rather than hand the
 * runner or the settings form a server we'd have to guess about.
 */
const dbMcpServerFieldsSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    authType: mcpAuthTypeSchema,
    args: z.array(z.string()).nullable(),
  }),
  z.object({ type: mcpHttpServerTypeSchema, authType: mcpAuthTypeSchema, url: z.string() }),
]);

function parseDbMcpServer(mcp: DbMcpServer): z.infer<typeof dbMcpServerFieldsSchema> {
  const parsed = dbMcpServerFieldsSchema.safeParse({
    type: mcp.type,
    authType: mcp.authType,
    url: mcp.url,
    args: mcp.args === null ? null : JSON.parse(mcp.args),
  });
  if (!parsed.success) {
    throw new Error(`Invalid stored MCP server "${mcp.name}": ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Format env var DB rows for display (mask secrets)
 */
export function formatEnvVarsForDisplay(envVars: DbEnvVar[]) {
  return envVars.map(({ id, name, value, isSecret }) => maskSecret({ id, name, value, isSecret }));
}

/**
 * Format MCP server DB rows for display (mask secrets, parse JSON)
 */
export function formatMcpServersForDisplay(mcpServers: DbMcpServer[]): McpServer[] {
  return mcpServers.map((mcp) => {
    const fields = parseDbMcpServer(mcp);
    return {
      id: mcp.id,
      name: mcp.name,
      type: fields.type,
      command: mcp.command,
      args: (fields.type === 'stdio' && fields.args) || [],
      env: maskedValuesOfKind(mcp.values, 'env'),
      url: fields.type === 'stdio' ? undefined : fields.url,
      headers: maskedValuesOfKind(mcp.values, 'header'),
      authType: fields.authType,
      ...(fields.authType === 'oauth' ? { oauth: formatOAuthStatus(mcp.oauth) } : {}),
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
 * Decrypt a server's values of one kind. Returns undefined rather than `{}` so a
 * server with none omits the field entirely.
 */
function decryptValuesOfKind(
  values: DbMcpServerValue[],
  kind: McpServerValueKind
): Record<string, string> | undefined {
  const record = valuesOfKind(values, kind, (v) => (v.isSecret ? decrypt(v.value) : v.value));
  return Object.keys(record).length > 0 ? record : undefined;
}

export function decryptMcpServers(mcpServers: DbMcpServer[]): ResolvedMcpServer[] {
  return mcpServers.map((mcp) => {
    const fields = parseDbMcpServer(mcp);

    if (fields.type !== 'stdio') {
      return {
        name: mcp.name,
        type: fields.type,
        url: fields.url,
        headers: decryptValuesOfKind(mcp.values, 'header'),
        ...(fields.authType === 'oauth' && mcp.oauth
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
      args: fields.args ?? undefined,
      env: decryptValuesOfKind(mcp.values, 'env'),
    };
  });
}

// ─── MCP Server Write Plan ───────────────────────────────────────────

/** A value to store as given (encrypted if secret). */
export interface McpServerValueWrite {
  name: string;
  value: string;
  isSecret: boolean;
}

/**
 * What saving an MCP server writes. Values with an empty secret are "unchanged":
 * they go in `keep` rather than `values`, so their stored row is neither written
 * nor deleted. Every other stored value of the server is deleted.
 */
export interface McpServerWritePlan {
  row: { type: string; command: string; args: string | null; url: string | null; authType: string };
  kind: McpServerValueKind;
  values: McpServerValueWrite[];
  keep: string[];
}

export function planMcpServerWrite(server: McpServerInput): McpServerWritePlan {
  const isStdio = server.type === 'stdio';
  const input = (isStdio ? server.env : server.headers) ?? {};
  const values: McpServerValueWrite[] = [];
  const keep: string[] = [];
  for (const [name, { value, isSecret }] of Object.entries(input)) {
    if (isSecret && value === '') keep.push(name);
    else values.push({ name, value: isSecret ? encrypt(value) : value, isSecret });
  }

  return {
    row: {
      type: server.type,
      command: isStdio ? server.command : '',
      args: isStdio && server.args ? JSON.stringify(server.args) : null,
      url: isStdio ? null : server.url,
      authType: isStdio ? 'headers' : server.authType,
    },
    kind: valueKindFor(server.type),
    values,
    keep,
  };
}

/**
 * Check if an MCP server input has any secret values
 */
export function mcpServerHasSecrets(server: McpServerInput): boolean {
  if (server.type !== 'stdio' && server.authType === 'oauth') return true;
  const secretEntries = server.type === 'stdio' ? (server.env ?? {}) : (server.headers ?? {});
  return Object.values(secretEntries).some((e) => e.isSecret);
}
