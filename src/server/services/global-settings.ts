import { prisma } from '@/lib/prisma';
import { DEFAULT_PAUSE_THRESHOLD } from '@/lib/rate-limit';
import { DEFAULT_SETTING_SOURCE_FLAGS } from '@/lib/setting-sources';
import type { GlobalSettings, Prisma } from '@/generated/prisma/client';
import { GLOBAL_SETTINGS_ID } from './settings-scope';

/** The singleton row's settings columns. */
export type GlobalSettingsValues = Omit<GlobalSettings, 'id' | 'createdAt' | 'updatedAt'>;

type GlobalSettingsPatch = Partial<
  Omit<Prisma.GlobalSettingsCreateInput, 'id' | 'createdAt' | 'updatedAt'>
>;

/**
 * What every setting reads as before the row exists. Must match the schema's
 * column defaults, which apply once the first write creates the row. A nullable
 * column's null means "use the built-in default" (e.g. `ttsSpeed`), which the
 * consumer resolves, so the UI can still tell "unset" from an explicit value.
 */
export const GLOBAL_SETTINGS_DEFAULTS: Readonly<GlobalSettingsValues> = Object.freeze({
  systemPromptOverride: null,
  systemPromptOverrideEnabled: false,
  systemPromptAppend: null,
  claudeModel: null,
  advisorModel: null,
  claudeApiKey: null,
  ttsSpeed: null,
  ttsVoice: null,
  voiceAutoSend: true,
  settingSourceUser: DEFAULT_SETTING_SOURCE_FLAGS.user,
  settingSourceProject: DEFAULT_SETTING_SOURCE_FLAGS.project,
  settingSourceLocal: DEFAULT_SETTING_SOURCE_FLAGS.local,
  rateLimitPauseEnabled: false,
  rateLimitPauseThreshold: DEFAULT_PAUSE_THRESHOLD,
});

export async function loadGlobalSettings(): Promise<Readonly<GlobalSettingsValues>> {
  const row = await prisma.globalSettings.findUnique({
    where: { id: GLOBAL_SETTINGS_ID },
    omit: { id: true, createdAt: true, updatedAt: true },
  });
  return row ?? GLOBAL_SETTINGS_DEFAULTS;
}

/** Write some fields of the singleton row, creating it on first use. */
export async function patchGlobalSettings(patch: GlobalSettingsPatch): Promise<void> {
  await prisma.globalSettings.upsert({
    where: { id: GLOBAL_SETTINGS_ID },
    create: { id: GLOBAL_SETTINGS_ID, ...patch },
    update: patch,
  });
}
