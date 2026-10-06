import { randomUUID } from 'crypto';
import { TRPCError } from '@trpc/server';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@/generated/prisma/client';
import { encrypt, decrypt } from '@/lib/crypto';
import { createLogger } from '@/lib/logger';
import {
  MCP_SERVER_INCLUDE,
  decryptMcpServers,
  formatEnvVarsForDisplay,
  formatMcpServersForDisplay,
  mcpServerHasSecrets,
  planMcpServerWrite,
  requireEncryptionForSecrets,
  type EnvVarInput,
  type McpServerInput,
} from './settings-helpers';
import { validateMcpServer } from './mcp-validator';
import {
  applyMcpOAuthHeaders,
  disconnectMcpOAuth,
  invalidateMcpOAuthOnUrlChange,
  startMcpOAuthFlow,
  syncMcpOAuthConfig,
} from './mcp-oauth';

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
    prisma.mcpServer.findMany({
      where: scope,
      orderBy: { name: 'asc' },
      include: MCP_SERVER_INCLUDE,
    }),
  ]);
  return {
    envVars: formatEnvVarsForDisplay(envVars),
    mcpServers: formatMcpServersForDisplay(mcpServers),
  };
}

/**
 * Create or update an env var. An empty secret value means "unchanged", so the
 * stored row is left as it is — including whatever another writer made of it.
 */
export async function upsertEnvVar(scope: SettingsScope, envVar: EnvVarInput): Promise<void> {
  requireEncryptionForSecrets(envVar.isSecret);
  if (envVar.isSecret && envVar.value === '') return;

  const value = envVar.isSecret ? encrypt(envVar.value) : envVar.value;
  const now = new Date().toISOString();

  await prisma.$executeRaw`
    INSERT INTO "EnvVar" ("id", "repoSettingsId", "name", "value", "isSecret", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${scope.repoSettingsId}, ${envVar.name}, ${value}, ${envVar.isSecret ? 1 : 0}, ${now}, ${now})
    ${conflictTarget(scope)} DO UPDATE SET
      "value" = excluded."value",
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
 * Create or update an MCP server. Each env var/header is its own row, so an
 * unchanged secret (empty value + isSecret) is simply not written, and not deleted
 * either — whatever another writer made of it stands.
 *
 * Deliberately not a transaction: the better-sqlite3 adapter shares one connection,
 * so other requests' queries would run inside it. Each row is last-writer-wins.
 */
export async function upsertMcpServer(scope: SettingsScope, server: McpServerInput): Promise<void> {
  requireEncryptionForSecrets(mcpServerHasSecrets(server));
  const plan = planMcpServerWrite(server);
  const serverKey = { ...scope, name: server.name };

  // A stdio save deletes the grant outright in syncMcpOAuthConfig.
  if (plan.row.url !== null) await invalidateMcpOAuthOnUrlChange(serverKey, plan.row.url);

  const now = new Date().toISOString();
  // RETURNING gives the values and OAuth grant the server's id without a second
  // read, whether the statement inserted a new row or updated the existing one.
  const [{ id }] = await prisma.$queryRaw<[{ id: string }]>`
    INSERT INTO "McpServer" ("id", "repoSettingsId", "name", "type", "command", "args", "url", "authType", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${scope.repoSettingsId}, ${server.name}, ${plan.row.type}, ${plan.row.command}, ${plan.row.args}, ${plan.row.url}, ${plan.row.authType}, ${now}, ${now})
    ${conflictTarget(scope)} DO UPDATE SET
      "type" = excluded."type",
      "command" = excluded."command",
      "args" = excluded."args",
      "url" = excluded."url",
      "authType" = excluded."authType",
      "updatedAt" = excluded."updatedAt"
    RETURNING "id"`;

  if (plan.values.length > 0) {
    const rows = plan.values.map(
      (v) =>
        Prisma.sql`(${randomUUID()}, ${id}, ${plan.kind}, ${v.name}, ${v.value}, ${v.isSecret ? 1 : 0}, ${now}, ${now})`
    );
    await prisma.$executeRaw`
      INSERT INTO "McpServerValue" ("id", "mcpServerId", "kind", "name", "value", "isSecret", "createdAt", "updatedAt")
      VALUES ${Prisma.join(rows)}
      ON CONFLICT("mcpServerId", "kind", "name") DO UPDATE SET
        "value" = excluded."value",
        "isSecret" = excluded."isSecret",
        "updatedAt" = excluded."updatedAt"`;
  }

  const submitted = [...plan.values.map((v) => v.name), ...plan.keep];
  await prisma.mcpServerValue.deleteMany({
    where: { mcpServerId: id, NOT: { kind: plan.kind, name: { in: submitted } } },
  });

  await syncMcpOAuthConfig({
    mcpServerId: id,
    url: plan.row.url,
    authType: plan.row.authType,
    clientId: server.type === 'stdio' ? '' : (server.oauth?.clientId ?? ''),
    clientSecret: server.type === 'stdio' ? '' : (server.oauth?.clientSecret ?? ''),
    scope: server.type === 'stdio' ? '' : (server.oauth?.scope ?? ''),
  });

  log.info('Set MCP server', { ...scope, name: server.name, type: server.type });
}

async function requireMcpServer(scope: SettingsScope, name: string) {
  const row = await prisma.mcpServer.findFirst({
    where: { ...scope, name },
    include: MCP_SERVER_INCLUDE,
  });
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `MCP server "${name}" not found` });
  }
  return row;
}

export async function deleteMcpServer(scope: SettingsScope, name: string): Promise<void> {
  await prisma.mcpServer.deleteMany({ where: { ...scope, name } });
  log.info('Deleted MCP server', { ...scope, name });
}

/** Connect to a stored MCP server with its decrypted config and list its tools. */
export async function validateScopeMcpServer(scope: SettingsScope, name: string) {
  const row = await requireMcpServer(scope, name);
  const [decrypted] = await applyMcpOAuthHeaders(decryptMcpServers([row]));
  return validateMcpServer(decrypted);
}

/**
 * Begin the OAuth authorization for a stored server and return the URL the
 * user's browser must visit. `appOrigin` comes from the request rather than
 * config because the redirect URI has to be reachable from that browser.
 */
export async function startScopeMcpOAuth(
  scope: SettingsScope,
  name: string,
  appOrigin: string
): Promise<{ authorizeUrl: string }> {
  const row = await requireMcpServer(scope, name);
  if (row.authType !== 'oauth' || !row.url) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `MCP server "${name}" is not configured for OAuth`,
    });
  }
  return startMcpOAuthFlow({ mcpServerId: row.id, url: row.url, appOrigin });
}

/** Drop the stored tokens for a server, leaving its configuration in place. */
export async function disconnectScopeMcpOAuth(scope: SettingsScope, name: string): Promise<void> {
  const row = await requireMcpServer(scope, name);
  await disconnectMcpOAuth(row.id);
}
