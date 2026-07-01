import type { ContainerEnvVar, ContainerMcpServer } from './repo-settings';
import { getRepoSettingsForContainer } from './repo-settings';
import { getGlobalSettingsForContainer, type GlobalContainerSettings } from './global-settings';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { env } from '@/lib/env';

/**
 * Model used for the server-side advisor tool when no global override is set.
 * Setting an advisor model is also what enables the advisor tool for a session,
 * so this default means the advisor tool is available (on Fable 5) out of the box.
 */
export const DEFAULT_ADVISOR_MODEL = 'claude-fable-5';

/**
 * Fully merged session settings ready for container creation and Claude queries.
 */
export interface MergedSessionSettings {
  systemPrompt: string;
  envVars: ContainerEnvVar[];
  mcpServers: ContainerMcpServer[];
  claudeModel: string | undefined;
  /** Always resolved (never undefined) — see {@link resolveAdvisorModel}. */
  advisorModel: string;
  claudeApiKey: string | undefined;
  customSystemPrompt: string | null | undefined;
  globalSettings: GlobalContainerSettings;
}

/**
 * Load and merge global + per-repo settings into a single object.
 * Fetches repo and global settings in parallel, builds the system prompt,
 * and merges env vars and MCP servers.
 */
export async function loadMergedSessionSettings(
  repoFullName: string | null | undefined
): Promise<MergedSessionSettings> {
  const [repoSettings, globalSettings] = await Promise.all([
    repoFullName ? getRepoSettingsForContainer(repoFullName) : null,
    getGlobalSettingsForContainer(),
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
      repoSettings?.claudeModel,
      globalSettings.claudeModel,
      env.CLAUDE_MODEL
    ),
    advisorModel: resolveAdvisorModel(globalSettings.advisorModel),
    claudeApiKey: globalSettings.claudeApiKey ?? undefined,
    customSystemPrompt: repoSettings?.customSystemPrompt,
    globalSettings,
  };
}

/**
 * Resolve the effective Claude model, in precedence order:
 * per-repo override → global override → CLAUDE_MODEL env var.
 */
export function resolveClaudeModel(
  repoModel: string | null | undefined,
  globalModel: string | null | undefined,
  envModel: string | undefined
): string | undefined {
  return repoModel ?? globalModel ?? envModel;
}

/**
 * Resolve the effective advisor model: the global override, falling back to
 * {@link DEFAULT_ADVISOR_MODEL}. Always returns a value, so the advisor tool is
 * always enabled for a session (there is no "off" state — a global override only
 * changes which model the advisor uses).
 */
export function resolveAdvisorModel(globalModel: string | null | undefined): string {
  // Guard against an empty/whitespace value: returning "" would hand the SDK an
  // invalid model. The write path already stores blank input as null, so this is
  // defensive — it keeps the resolver correct regardless of how the value got there.
  return globalModel?.trim() || DEFAULT_ADVISOR_MODEL;
}

/**
 * Merge global and per-repo environment variables.
 * Per-repo env vars take precedence over global ones with the same name.
 */
export function mergeEnvVars(
  globalEnvVars: ContainerEnvVar[],
  repoEnvVars: ContainerEnvVar[]
): ContainerEnvVar[] {
  const merged = new Map<string, ContainerEnvVar>();

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
  globalMcpServers: ContainerMcpServer[],
  repoMcpServers: ContainerMcpServer[]
): ContainerMcpServer[] {
  const merged = new Map<string, ContainerMcpServer>();

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
export function mcpServersEqual(a: ContainerMcpServer[], b: ContainerMcpServer[]): boolean {
  if (a.length !== b.length) return false;
  const key = (servers: ContainerMcpServer[]) =>
    [...servers]
      .sort((x, y) => x.name.localeCompare(y.name))
      .map((s) => JSON.stringify(s))
      .join('\n');
  return key(a) === key(b);
}
