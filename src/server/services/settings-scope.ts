import { randomUUID } from 'crypto';
import { TRPCError } from '@trpc/server';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@/generated/prisma/client';
import { encrypt, decrypt } from '@/lib/crypto';
import { createLogger } from '@/lib/logger';
import {
  buildMcpServerData,
  decryptMcpServers,
  formatEnvVarsForDisplay,
  formatMcpServersForDisplay,
  mcpServerHasSecrets,
  requireEncryptionForSecrets,
  type EnvVarInput,
  type McpServerInput,
} from './settings-helpers';
import { validateMcpServer } from './mcp-validator';

const log = createLogger('settings-scope');

/**
 * Env vars and MCP servers live in one table each, scoped by `repoSettingsId`:
 * a RepoSettings id for per-repo entries, null for global ones. Every operation
 * below is scope-agnostic so the two routers share one implementation.
 *
 * Uniqueness of (scope, name) is a compound unique for repo rows and a hand-written
 * partial unique index for global rows (see prisma/schema.prisma), so writes use
 * `INSERT ... ON CONFLICT` via raw SQL — Prisma's `upsert` can't target a partial
 * index — instead of a read-then-branch.
 */
export interface SettingsScope {
  repoSettingsId: string | null;
}

export const GLOBAL_SCOPE: Readonly<SettingsScope> = Object.freeze({ repoSettingsId: null });

/** Id of the GlobalSettings singleton row. */
export const GLOBAL_SETTINGS_ID = 'global';

function conflictTarget(scope: SettingsScope): Prisma.Sql {
  return scope.repoSettingsId === null
    ? Prisma.sql`ON CONFLICT("name") WHERE "repoSettingsId" IS NULL`
    : Prisma.sql`ON CONFLICT("repoSettingsId", "name")`;
}

export async function listScopeSettings(scope: SettingsScope) {
  const [envVars, mcpServers] = await Promise.all([
    prisma.envVar.findMany({ where: scope, orderBy: { name: 'asc' } }),
    prisma.mcpServer.findMany({ where: scope, orderBy: { name: 'asc' } }),
  ]);
  return {
    envVars: formatEnvVarsForDisplay(envVars),
    mcpServers: formatMcpServersForDisplay(mcpServers),
  };
}

/**
 * Create or update an env var. An empty secret value means "unchanged": the
 * stored ciphertext is kept, decided inside the statement so there is no
 * read-then-write.
 */
export async function upsertEnvVar(scope: SettingsScope, envVar: EnvVarInput): Promise<void> {
  requireEncryptionForSecrets(envVar.isSecret);
  const keepExisting = envVar.isSecret && envVar.value === '' ? 1 : 0;
  const value = envVar.isSecret ? encrypt(envVar.value) : envVar.value;
  const now = new Date().toISOString();

  await prisma.$executeRaw`
    INSERT INTO "EnvVar" ("id", "repoSettingsId", "name", "value", "isSecret", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${scope.repoSettingsId}, ${envVar.name}, ${value}, ${envVar.isSecret ? 1 : 0}, ${now}, ${now})
    ${conflictTarget(scope)} DO UPDATE SET
      "value" = CASE WHEN ${keepExisting} AND "EnvVar"."isSecret" THEN "EnvVar"."value" ELSE excluded."value" END,
      "isSecret" = excluded."isSecret",
      "updatedAt" = excluded."updatedAt"`;

  log.info('Set env var', { ...scope, name: envVar.name, isSecret: envVar.isSecret });
}

export async function deleteEnvVar(scope: SettingsScope, name: string): Promise<void> {
  await prisma.envVar.deleteMany({ where: { ...scope, name } });
  log.info('Deleted env var', { ...scope, name });
}

/** Decrypted value for the "reveal" button. */
export async function getEnvVarValue(scope: SettingsScope, name: string): Promise<string> {
  const envVar = await prisma.envVar.findFirst({ where: { ...scope, name } });
  if (!envVar) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment variable not found' });
  }
  return envVar.isSecret ? decrypt(envVar.value) : envVar.value;
}

/**
 * Create or update an MCP server. Unchanged secrets (empty value + isSecret) are
 * carried over from the existing row's JSON, which needs a read; the write itself
 * is still a single ON CONFLICT statement.
 */
export async function upsertMcpServer(scope: SettingsScope, server: McpServerInput): Promise<void> {
  requireEncryptionForSecrets(mcpServerHasSecrets(server));
  const existing = await prisma.mcpServer.findFirst({
    where: { ...scope, name: server.name },
    select: { env: true, headers: true },
  });
  const data = buildMcpServerData(server, existing);
  const now = new Date().toISOString();

  await prisma.$executeRaw`
    INSERT INTO "McpServer" ("id", "repoSettingsId", "name", "type", "command", "args", "env", "url", "headers", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${scope.repoSettingsId}, ${server.name}, ${data.type}, ${data.command}, ${data.args}, ${data.env}, ${data.url}, ${data.headers}, ${now}, ${now})
    ${conflictTarget(scope)} DO UPDATE SET
      "type" = excluded."type",
      "command" = excluded."command",
      "args" = excluded."args",
      "env" = excluded."env",
      "url" = excluded."url",
      "headers" = excluded."headers",
      "updatedAt" = excluded."updatedAt"`;

  log.info('Set MCP server', { ...scope, name: server.name, type: server.type });
}

export async function deleteMcpServer(scope: SettingsScope, name: string): Promise<void> {
  await prisma.mcpServer.deleteMany({ where: { ...scope, name } });
  log.info('Deleted MCP server', { ...scope, name });
}

/** Connect to a stored MCP server with its decrypted config and list its tools. */
export async function validateScopeMcpServer(scope: SettingsScope, name: string) {
  const row = await prisma.mcpServer.findFirst({ where: { ...scope, name } });
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `MCP server "${name}" not found` });
  }
  const [decrypted] = decryptMcpServers([row]);
  return validateMcpServer(decrypted);
}
