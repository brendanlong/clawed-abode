import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';
import { buildSystemPrompt } from '@/lib/system-prompt';
import {
  resolveSettingSources,
  settingSourceFlagsFromRow,
  type SettingSource,
  type SettingSourceFlags,
} from '@/lib/setting-sources';
import { env } from '@/lib/env';
import { publicFilesUrl } from '@/lib/public-files';
import type { ResolvedEnvVar, ResolvedMcpServer } from '@/lib/settings-types';
import { MCP_SERVER_INCLUDE, decryptEnvVars, decryptMcpServers } from './settings-helpers';
import { GLOBAL_SCOPE } from './settings-scope';
import { loadGlobalSettings } from './global-settings';
import { applyMcpOAuthHeaders } from './mcp-oauth';
import { getSessionPublicDir } from './public-dir';
import { resolveBuiltinTools, type BuiltinToolsLevel } from '@/lib/builtin-tools';

/** Per-repo settings with secrets decrypted, ready to merge. */
export interface ResolvedRepoSettings {
  customSystemPrompt: string | null;
  claudeModel: string | null;
  envVars: ResolvedEnvVar[];
  mcpServers: ResolvedMcpServer[];
}

/** Global settings with secrets decrypted, ready to merge. */
export interface ResolvedGlobalSettings {
  systemPromptOverride: string | null;
  systemPromptOverrideEnabled: boolean;
  systemPromptAppend: string | null;
  claudeModel: string | null;
  advisorModel: string | null;
  claudeApiKey: string | null;
  settingSources: SettingSourceFlags;
  builtinTools: BuiltinToolsLevel | null;
  envVars: ResolvedEnvVar[];
  mcpServers: ResolvedMcpServer[];
}

export async function loadResolvedRepoSettings(
  repoFullName: string
): Promise<ResolvedRepoSettings | null> {
  const settings = await prisma.repoSettings.findUnique({
    where: { repoFullName },
    include: { envVars: true, mcpServers: { include: MCP_SERVER_INCLUDE } },
  });
  if (!settings) return null;
  return {
    customSystemPrompt: settings.customSystemPrompt,
    claudeModel: settings.claudeModel,
    envVars: decryptEnvVars(settings.envVars),
    mcpServers: decryptMcpServers(settings.mcpServers),
  };
}

export async function loadResolvedGlobalSettings(): Promise<ResolvedGlobalSettings> {
  const [settings, envVarRows, mcpServerRows] = await Promise.all([
    loadGlobalSettings(),
    prisma.envVar.findMany({ where: GLOBAL_SCOPE }),
    prisma.mcpServer.findMany({ where: GLOBAL_SCOPE, include: MCP_SERVER_INCLUDE }),
  ]);
  return {
    systemPromptOverride: settings.systemPromptOverride,
    systemPromptOverrideEnabled: settings.systemPromptOverrideEnabled,
    systemPromptAppend: settings.systemPromptAppend,
    claudeModel: settings.claudeModel,
    advisorModel: settings.advisorModel,
    claudeApiKey: settings.claudeApiKey ? decrypt(settings.claudeApiKey) : null,
    settingSources: settingSourceFlagsFromRow(settings),
    builtinTools: resolveBuiltinTools(settings),
    envVars: decryptEnvVars(envVarRows),
    mcpServers: decryptMcpServers(mcpServerRows),
  };
}

/**
 * The Claude credential in effect for server-side Anthropic API calls: the
 * encrypted global override when set, else `CLAUDE_CODE_OAUTH_TOKEN`.
 */
export async function loadClaudeCredential(): Promise<string | null> {
  const { claudeApiKey } = await loadGlobalSettings();
  const stored = claudeApiKey ? decrypt(claudeApiKey) : null;
  return stored || env.CLAUDE_CODE_OAUTH_TOKEN || null;
}

/**
 * Fully merged session settings for establishing a Claude query.
 */
export interface MergedSessionSettings {
  systemPrompt: string;
  envVars: ResolvedEnvVar[];
  mcpServers: ResolvedMcpServer[];
  claudeModel: string | undefined;
  /** Effective advisor model, or null when the advisor tool is disabled. */
  advisorModel: string | null;
  claudeApiKey: string | undefined;
  /** Claude Code scopes the SDK loads filesystem config from — see {@link resolveSettingSources}. */
  settingSources: SettingSource[];
  /** Built-in MCP tools the session gets, or null for none. */
  builtinTools: BuiltinToolsLevel | null;
}

/**
 * Load and merge global + per-repo settings into a single object.
 * Fetches repo and global settings in parallel, builds the system prompt,
 * and merges env vars and MCP servers.
 */
export async function loadMergedSessionSettings(
  sessionId: string,
  repoFullName: string | null | undefined,
  sessionModel?: string | null | undefined
): Promise<MergedSessionSettings> {
  const [repoSettings, globalSettings] = await Promise.all([
    repoFullName ? loadResolvedRepoSettings(repoFullName) : null,
    loadResolvedGlobalSettings(),
  ]);

  const systemPrompt = buildSystemPrompt({
    publicDir: env.PUBLIC_FILES_URL
      ? {
          path: getSessionPublicDir(sessionId),
          url: publicFilesUrl(env.PUBLIC_FILES_URL, sessionId),
        }
      : undefined,
    customSystemPrompt: repoSettings?.customSystemPrompt,
    globalSettings,
  });

  const envVars = mergeByName(globalSettings.envVars, repoSettings?.envVars ?? []);
  // OAuth tokens are minted after merging so a server shadowed by a per-repo
  // entry of the same name never spends a refresh on a config nobody will use.
  const mcpServers = await applyMcpOAuthHeaders(
    mergeByName(globalSettings.mcpServers, repoSettings?.mcpServers ?? [])
  );

  return {
    systemPrompt,
    envVars,
    mcpServers,
    claudeModel:
      sessionModel ?? repoSettings?.claudeModel ?? globalSettings.claudeModel ?? env.CLAUDE_MODEL,
    // No default advisor: the tool is opt-in, and a blank setting disables it.
    advisorModel: globalSettings.advisorModel?.trim() || null,
    claudeApiKey: globalSettings.claudeApiKey ?? undefined,
    settingSources: resolveSettingSources(globalSettings.settingSources),
    builtinTools: globalSettings.builtinTools,
  };
}

/** Per-repo entries take precedence over global ones with the same name. */
export function mergeByName<T extends { name: string }>(globals: T[], repo: T[]): T[] {
  const merged = new Map<string, T>();
  for (const entry of [...globals, ...repo]) {
    merged.set(entry.name, entry);
  }
  return Array.from(merged.values());
}

/**
 * Whether two merged MCP server lists are equivalent (order-insensitive), used to
 * decide whether to apply a live `setMcpServers` to a running query when settings
 * change between turns.
 */
export function mcpServersEqual(a: ResolvedMcpServer[], b: ResolvedMcpServer[]): boolean {
  if (a.length !== b.length) return false;
  const key = (servers: ResolvedMcpServer[]) =>
    [...servers]
      .sort((x, y) => x.name.localeCompare(y.name))
      .map((s) => JSON.stringify(s))
      .join('\n');
  return key(a) === key(b);
}
