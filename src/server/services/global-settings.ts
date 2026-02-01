import { prisma } from '@/lib/prisma';

// The singleton ID for global settings
const GLOBAL_SETTINGS_ID = 'global';

/**
 * Global settings for use in Claude sessions
 */
export interface GlobalSystemPromptSettings {
  systemPromptOverride: string | null;
  systemPromptOverrideEnabled: boolean;
  systemPromptAppend: string | null;
}

/**
 * Get global settings for use in Claude sessions
 * Returns defaults if no settings exist
 */
export async function getGlobalSettings(): Promise<GlobalSystemPromptSettings> {
  const settings = await prisma.globalSettings.findUnique({
    where: { id: GLOBAL_SETTINGS_ID },
  });

  if (!settings) {
    return {
      systemPromptOverride: null,
      systemPromptOverrideEnabled: false,
      systemPromptAppend: null,
    };
  }

  return {
    systemPromptOverride: settings.systemPromptOverride,
    systemPromptOverrideEnabled: settings.systemPromptOverrideEnabled,
    systemPromptAppend: settings.systemPromptAppend,
  };
}
