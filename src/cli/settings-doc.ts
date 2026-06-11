/**
 * Pure conversions between database settings rows and the JSON documents the
 * abode CLI opens in $EDITOR. Secrets are decrypted into the document for
 * editing and re-encrypted on save, so the document round-trips losslessly.
 */

import { z } from 'zod';
import type { EnvVar, McpServer } from '@prisma/client';
import { decrypt, encrypt } from '@/lib/crypto';
import {
  envVarSchema,
  mcpServerSchema,
  type McpServerEnvValue,
} from '@/server/services/settings-helpers';

// ─── Editor document schemas ─────────────────────────────────────────

export const globalSettingsDocSchema = z.object({
  claudeModel: z.string().nullable(),
  /** Plaintext OAuth token; null = use the CLAUDE_CODE_OAUTH_TOKEN env var */
  claudeApiKey: z.string().nullable(),
  systemPromptOverrideEnabled: z.boolean(),
  systemPromptOverride: z.string().nullable(),
  systemPromptAppend: z.string().nullable(),
  envVars: z.array(envVarSchema),
  mcpServers: z.array(mcpServerSchema),
});

export const repoSettingsDocSchema = z.object({
  isFavorite: z.boolean(),
  claudeModel: z.string().nullable(),
  customSystemPrompt: z.string().nullable(),
  envVars: z.array(envVarSchema),
  mcpServers: z.array(mcpServerSchema),
});

export type GlobalSettingsDoc = z.infer<typeof globalSettingsDocSchema>;
export type RepoSettingsDoc = z.infer<typeof repoSettingsDocSchema>;

// ─── DB → document ───────────────────────────────────────────────────

export function envVarsToDoc(envVars: EnvVar[]): GlobalSettingsDoc['envVars'] {
  return envVars.map((ev) => ({
    name: ev.name,
    value: ev.isSecret ? decrypt(ev.value) : ev.value,
    isSecret: ev.isSecret,
  }));
}

function decryptedEnvRecord(json: string | null): Record<string, McpServerEnvValue> | undefined {
  if (!json) return undefined;
  const parsed = JSON.parse(json) as Record<string, McpServerEnvValue>;
  const entries = Object.entries(parsed).map(([key, { value, isSecret }]) => [
    key,
    { value: isSecret ? decrypt(value) : value, isSecret },
  ]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function mcpServersToDoc(mcpServers: McpServer[]): GlobalSettingsDoc['mcpServers'] {
  return mcpServers.map((server) => {
    if (server.type === 'http' || server.type === 'sse') {
      return {
        name: server.name,
        type: server.type,
        url: server.url ?? '',
        headers: decryptedEnvRecord(server.headers),
      };
    }
    return {
      name: server.name,
      type: 'stdio' as const,
      command: server.command,
      args: server.args ? (JSON.parse(server.args) as string[]) : undefined,
      env: decryptedEnvRecord(server.env),
    };
  });
}

// ─── Document → DB row data ──────────────────────────────────────────

export function envVarDocToDb(
  envVar: GlobalSettingsDoc['envVars'][number],
  repoSettingsId: string | null
): Omit<EnvVar, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    repoSettingsId,
    name: envVar.name,
    value: envVar.isSecret ? encrypt(envVar.value) : envVar.value,
    isSecret: envVar.isSecret,
  };
}

function encryptedEnvJson(record: Record<string, McpServerEnvValue> | undefined): string | null {
  if (!record || Object.keys(record).length === 0) return null;
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(record).map(([key, { value, isSecret }]) => [
        key,
        { value: isSecret ? encrypt(value) : value, isSecret },
      ])
    )
  );
}

export function mcpServerDocToDb(
  server: GlobalSettingsDoc['mcpServers'][number],
  repoSettingsId: string | null
): Omit<McpServer, 'id' | 'createdAt' | 'updatedAt'> {
  const isStdio = server.type === 'stdio';
  return {
    repoSettingsId,
    name: server.name,
    type: server.type,
    command: isStdio ? server.command : '',
    args: isStdio && server.args?.length ? JSON.stringify(server.args) : null,
    env: isStdio ? encryptedEnvJson(server.env) : null,
    url: !isStdio ? server.url : null,
    headers: !isStdio ? encryptedEnvJson(server.headers) : null,
  };
}

/**
 * Whether a settings document contains any secret values (requires
 * ENCRYPTION_KEY to be configured before saving).
 */
export function docHasSecrets(doc: {
  envVars: GlobalSettingsDoc['envVars'];
  mcpServers: GlobalSettingsDoc['mcpServers'];
}): boolean {
  if (doc.envVars.some((ev) => ev.isSecret)) return true;
  return doc.mcpServers.some((server) => {
    const record = server.type === 'stdio' ? server.env : server.headers;
    return Object.values(record ?? {}).some((entry) => entry.isSecret);
  });
}
