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
import type { ResolvedEnvVar, ResolvedMcpServer } from '@/lib/settings-types';
import { decryptEnvVars, decryptMcpServers } from './settings-helpers';
import { GLOBAL_SCOPE } from './settings-scope';

export const GLOBAL_SETTINGS_ID = 'global';

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
  envVars: ResolvedEnvVar[];
  mcpServers: ResolvedMcpServer[];
}

export async function loadResolvedRepoSettings(
  repoFullName: string
): Promise<ResolvedRepoSettings | null> {
  const settings = await prisma.repoSettings.findUnique({
    where: { repoFullName },
    include: { envVars: true, mcpServers: true },
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
    prisma.globalSettings.findUnique({ where: { id: GLOBAL_SETTINGS_ID } }),
    prisma.envVar.findMany({ where: GLOBAL_SCOPE }),
    prisma.mcpServer.findMany({ where: GLOBAL_SCOPE }),
  ]);
  return {
    systemPromptOverride: settings?.systemPromptOverride ?? null,
    systemPromptOverrideEnabled: settings?.systemPromptOverrideEnabled ?? false,
    systemPromptAppend: settings?.systemPromptAppend ?? null,
    claudeModel: settings?.claudeModel ?? null,
    advisorModel: settings?.advisorModel ?? null,
    claudeApiKey: settings?.claudeApiKey ? decrypt(settings.claudeApiKey) : null,
    settingSources: settingSourceFlagsFromRow(settings),
    envVars: decryptEnvVars(envVarRows),
    mcpServers: decryptMcpServers(mcpServerRows),
  };
}

/**
 * Fully merged session settings for establishing a Claude query.
 */
export interface MergedSessionSettings {
  systemPrompt: string;
  envVars: ResolvedEnvVar[];
  mcpServers: ResolvedMcpServer[];
  claudeModel: string | undefined;
  /** Effective advisor model, or null when the advisor tool is disabled — see {@link resolveAdvisorModel}. */
  advisorModel: string | null;
  claudeApiKey: string | undefined;
  /** Claude Code scopes the SDK loads filesystem config from — see {@link resolveSettingSources}. */
  settingSources: SettingSource[];
  customSystemPrompt: string | null | undefined;
  globalSettings: ResolvedGlobalSettings;
}

/**
 * Load and merge global + per-repo settings into a single object.
 * Fetches repo and global settings in parallel, builds the system prompt,
 * and merges env vars and MCP servers.
 */
export async function loadMergedSessionSettings(
  repoFullName: string | null | undefined,
  sessionModel?: string | null | undefined
): Promise<MergedSessionSettings> {
  const [repoSettings, globalSettings] = await Promise.all([
    repoFullName ? loadResolvedRepoSettings(repoFullName) : null,
    loadResolvedGlobalSettings(),
  ]);

  const systemPrompt = buildSystemPrompt({
    customSystemPrompt: repoSettings?.customSystemPrompt,
    globalSettings,
  });

  const envVars = mergeEnvVars(globalSettings.envVars, repoSettings?.envVars ?? []);
  const mcpServers = mergeMcpServers(globalSettings.mcpServers, repoSettings?.mcpServers ?? []);

  return {
    systemPrompt,
    envVars,
    mcpServers,
    claudeModel: resolveClaudeModel(
      sessionModel,
      repoSettings?.claudeModel,
      globalSettings.claudeModel,
      env.CLAUDE_MODEL
    ),
    advisorModel: resolveAdvisorModel(globalSettings.advisorModel),
    claudeApiKey: globalSettings.claudeApiKey ?? undefined,
    settingSources: resolveSettingSources(globalSettings.settingSources),
    customSystemPrompt: repoSettings?.customSystemPrompt,
    globalSettings,
  };
}

/**
 * Resolve the effective Claude model, in precedence order:
 * per-session override → per-repo override → global override → CLAUDE_MODEL env var.
 */
export function resolveClaudeModel(
  sessionModel: string | null | undefined,
  repoModel: string | null | undefined,
  globalModel: string | null | undefined,
  envModel: string | undefined
): string | undefined {
  return sessionModel ?? repoModel ?? globalModel ?? envModel;
}

/**
 * Resolve the effective advisor model from the global setting. Returns the
 * trimmed model when one is set, or null when unset/blank — null disables the
 * advisor tool for the session (there is no default; the tool is opt-in).
 */
export function resolveAdvisorModel(globalModel: string | null | undefined): string | null {
  // Normalize an empty/whitespace value to null so the caller has a single
  // "disabled" signal regardless of how the value got there.
  return globalModel?.trim() || null;
}

/**
 * Merge global and per-repo environment variables.
 * Per-repo env vars take precedence over global ones with the same name.
 */
export function mergeEnvVars(
  globalEnvVars: ResolvedEnvVar[],
  repoEnvVars: ResolvedEnvVar[]
): ResolvedEnvVar[] {
  const merged = new Map<string, ResolvedEnvVar>();

  // Add global env vars first
  for (const envVar of globalEnvVars) {
    merged.set(envVar.name, envVar);
  }

  // Per-repo env vars override global ones
  for (const envVar of repoEnvVars) {
    merged.set(envVar.name, envVar);
  }

  return Array.from(merged.values());
}

/**
 * Merge global and per-repo MCP servers.
 * Per-repo MCP servers take precedence over global ones with the same name.
 */
export function mergeMcpServers(
  globalMcpServers: ResolvedMcpServer[],
  repoMcpServers: ResolvedMcpServer[]
): ResolvedMcpServer[] {
  const merged = new Map<string, ResolvedMcpServer>();

  // Add global MCP servers first
  for (const server of globalMcpServers) {
    merged.set(server.name, server);
  }

  // Per-repo MCP servers override global ones
  for (const server of repoMcpServers) {
    merged.set(server.name, server);
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
