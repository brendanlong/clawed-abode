import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { encrypt } from '@/lib/crypto';
import { createLogger } from '@/lib/logger';
import { env } from '@/lib/env';
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/system-prompt';
import { nullableTextSchema, requireEncryptionForSecrets } from '../services/settings-helpers';
import { GLOBAL_SCOPE, GLOBAL_SETTINGS_ID, listScopeSettings } from '../services/settings-scope';
import { scopedSettingsProcedures } from './scoped-settings';
import { getModelSuggestions } from '../services/anthropic-models';
import { SUGGESTED_ADVISOR_MODEL } from '@/lib/advisor';
import { settingSourceFlagsFromRow, settingSourceFlagsSchema } from '@/lib/setting-sources';
import type { Prisma } from '@/generated/prisma/client';

const log = createLogger('globalSettings');

type GlobalSettingsPatch = Partial<
  Omit<Prisma.GlobalSettingsCreateInput, 'id' | 'createdAt' | 'updatedAt'>
>;

/** Write some fields of the singleton row, creating it on first use. */
async function patchGlobalSettings(patch: GlobalSettingsPatch): Promise<void> {
  await prisma.globalSettings.upsert({
    where: { id: GLOBAL_SETTINGS_ID },
    create: { id: GLOBAL_SETTINGS_ID, ...patch },
    update: patch,
  });
}

// Typed as `object` (not z.object({})'s Record<string, never>) so the shared
// procedures' inputs intersect cleanly with their own fields.
const noScopeInput: z.ZodType<object, object> = z.object({});

export const globalSettingsRouter = router({
  /** The built-in default system prompt, to pre-populate the override field. */
  getDefaultSystemPrompt: protectedProcedure.query(() => {
    return { defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT };
  }),

  /** Current global settings, with defaults when the row doesn't exist yet. */
  get: protectedProcedure.query(async () => {
    const settings = await prisma.globalSettings.findUnique({
      where: { id: GLOBAL_SETTINGS_ID },
    });

    return {
      systemPromptOverride: settings?.systemPromptOverride ?? null,
      systemPromptOverrideEnabled: settings?.systemPromptOverrideEnabled ?? false,
      systemPromptAppend: settings?.systemPromptAppend ?? null,
      claudeModel: settings?.claudeModel ?? null,
      advisorModel: settings?.advisorModel ?? null,
      hasClaudeApiKey: settings?.claudeApiKey !== null && settings?.claudeApiKey !== undefined,
      ttsSpeed: settings?.ttsSpeed ?? null,
      voiceAutoSend: settings?.voiceAutoSend ?? true,
      settingSources: settingSourceFlagsFromRow(settings),
      defaultClaudeModel: env.CLAUDE_MODEL,
      suggestedAdvisorModel: SUGGESTED_ADVISOR_MODEL,
      hasEnvApiKey: !!env.CLAUDE_CODE_OAUTH_TOKEN,
    };
  }),

  /** Well-known aliases + API models + inferred aliases; cached for an hour. */
  getModelSuggestions: protectedProcedure.query(async () => {
    const models = await getModelSuggestions();
    return { models };
  }),

  setSystemPromptOverride: protectedProcedure
    .input(
      z.object({
        systemPromptOverride: nullableTextSchema(50000),
        systemPromptOverrideEnabled: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      await patchGlobalSettings(input);
      log.info('Set system prompt override', {
        hasOverride: input.systemPromptOverride !== null,
        enabled: input.systemPromptOverrideEnabled,
      });
      return { success: true };
    }),

  setSystemPromptAppend: protectedProcedure
    .input(z.object({ systemPromptAppend: nullableTextSchema(50000) }))
    .mutation(async ({ input }) => {
      await patchGlobalSettings(input);
      log.info('Set system prompt append', { hasAppend: input.systemPromptAppend !== null });
      return { success: true };
    }),

  toggleSystemPromptOverrideEnabled: protectedProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await patchGlobalSettings({ systemPromptOverrideEnabled: input.enabled });
      log.info('Toggled system prompt override', { enabled: input.enabled });
      return { success: true };
    }),

  /** Global env vars and MCP servers (masked secrets): rows where repoSettingsId IS NULL. */
  getWithSettings: protectedProcedure.query(() => listScopeSettings(GLOBAL_SCOPE)),

  ...scopedSettingsProcedures(noScopeInput, async () => GLOBAL_SCOPE),

  /** Global Claude model override; null/blank reverts to CLAUDE_MODEL. */
  setClaudeModel: protectedProcedure
    .input(z.object({ claudeModel: nullableTextSchema(200) }))
    .mutation(async ({ input }) => {
      await patchGlobalSettings(input);
      log.info('Set Claude model', input);
      return { success: true };
    }),

  /** Advisor model for the server-side advisor tool; null/blank disables it (the default). */
  setAdvisorModel: protectedProcedure
    .input(z.object({ advisorModel: nullableTextSchema(200) }))
    .mutation(async ({ input }) => {
      await patchGlobalSettings(input);
      log.info('Set advisor model', input);
      return { success: true };
    }),

  /**
   * Which Claude Code scopes the SDK loads filesystem config from (CLAUDE.md,
   * skills, hooks, permissions). Takes effect on the next Stop→Start. See @/lib/setting-sources.
   */
  setSettingSources: protectedProcedure
    .input(settingSourceFlagsSchema)
    .mutation(async ({ input }) => {
      await patchGlobalSettings({
        settingSourceUser: input.user,
        settingSourceProject: input.project,
        settingSourceLocal: input.local,
      });
      log.info('Set setting sources', input);
      return { success: true };
    }),

  /** Claude API key (OAuth token) override, encrypted at rest; empty clears it. */
  setClaudeApiKey: protectedProcedure
    .input(z.object({ claudeApiKey: z.string().max(5000) }))
    .mutation(async ({ input }) => {
      const key = input.claudeApiKey.trim();
      if (key) requireEncryptionForSecrets(true);
      await patchGlobalSettings({ claudeApiKey: key ? encrypt(key) : null });
      log.info(key ? 'Set Claude API key' : 'Cleared Claude API key');
      return { success: true };
    }),

  /** TTS playback speed, 0.25–4.0; null resets to the default (1.0). */
  setTtsSpeed: protectedProcedure
    .input(z.object({ ttsSpeed: z.number().min(0.25).max(4.0).nullable() }))
    .mutation(async ({ input }) => {
      await patchGlobalSettings(input);
      log.info('Set TTS speed', input);
      return { success: true };
    }),

  /** When true, speech-to-text transcripts are sent as prompts immediately. */
  setVoiceAutoSend: protectedProcedure
    .input(z.object({ voiceAutoSend: z.boolean() }))
    .mutation(async ({ input }) => {
      await patchGlobalSettings(input);
      log.info('Set voice auto-send', input);
      return { success: true };
    }),
});
