import { z } from 'zod';

/**
 * Claude Code setting scopes the SDK can load filesystem config from. Mirrors
 * the SDK's `SettingSource` union (`'user' | 'project' | 'local'`); kept here as
 * a dependency-free source of truth so the server router and the client settings
 * UI share one definition. See
 * https://code.claude.com/docs/en/settings#available-scopes
 *
 * Each enabled scope contributes CLAUDE.md, skills, hooks, and permissions from
 * its directory:
 * - `user`    → `~/.claude/`
 * - `project` → `<cwd>/.claude/` (and parent `.claude/` dirs)
 * - `local`   → `<cwd>/.claude/settings.local.json`
 */
export const SETTING_SOURCES = ['user', 'project', 'local'] as const;

export type SettingSource = (typeof SETTING_SOURCES)[number];

/** Per-scope enable flags for the setting sources loaded into every session. */
export interface SettingSourceFlags {
  user: boolean;
  project: boolean;
  local: boolean;
}

/**
 * Defaults matching the historical hardcoded behavior: only the project scope is
 * loaded. Enabling `user` is what turns on personal skills / global CLAUDE.md /
 * hooks from the host user's home.
 */
export const DEFAULT_SETTING_SOURCE_FLAGS: SettingSourceFlags = {
  user: false,
  project: true,
  local: false,
};

export const settingSourceFlagsSchema = z.object({
  user: z.boolean(),
  project: z.boolean(),
  local: z.boolean(),
});

/**
 * Resolve the enable flags into the ordered `settingSources` array the SDK
 * expects. Order follows {@link SETTING_SOURCES}; disabled scopes are omitted.
 * All-off yields `[]`, which disables all filesystem config for the session.
 */
export function resolveSettingSources(flags: SettingSourceFlags): SettingSource[] {
  return SETTING_SOURCES.filter((source) => flags[source]);
}
