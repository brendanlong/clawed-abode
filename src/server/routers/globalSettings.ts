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
import { mcpOAuthRedirectUri } from '@/lib/mcp-oauth-urls';
import { kokoroVoiceSchema } from '@/lib/kokoro-voices';
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

/** Plain global settings, each validated on its own; see `update`. */
const globalSettingsUpdateSchema = z
  .object({
    systemPromptAppend: nullableTextSchema(50000),
    /** Claude model override; null reverts to CLAUDE_MODEL. */
    claudeModel: nullableTextSchema(200),
    /** Model for the server-side advisor tool; null disables it (the default). */
    advisorModel: nullableTextSchema(200),
    /** TTS playback speed; null resets to the default (1.0). */
    ttsSpeed: z.number().min(0.25).max(4.0).nullable(),
    /** Kokoro voice for read-aloud; null resets to the default. */
    ttsVoice: kokoroVoiceSchema.nullable(),
    /** When true, speech-to-text transcripts are sent as prompts immediately. */
    voiceAutoSend: z.boolean(),
  })
  .partial();

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
      ttsVoice: settings?.ttsVoice ?? null,
      ttsEnabled: !!env.TTS_BASE_URL,
      voiceAutoSend: settings?.voiceAutoSend ?? true,
      settingSources: settingSourceFlagsFromRow(settings),
      defaultClaudeModel: env.CLAUDE_MODEL,
      suggestedAdvisorModel: SUGGESTED_ADVISOR_MODEL,
      hasEnvApiKey: !!env.CLAUDE_CODE_OAUTH_TOKEN,
    };
  }),

  /**
   * The exact redirect URI to register with an OAuth provider. Server-resolved
   * because the client's own origin disagrees with it whenever APP_URL is set,
   * and a mismatched redirect_uri is rejected outright.
   */
  getMcpOAuthRedirectUri: protectedProcedure.query(({ ctx }) => ({
    redirectUri: ctx.appOrigin ? mcpOAuthRedirectUri(ctx.appOrigin) : null,
  })),

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

  /** Global env vars and MCP servers (masked secrets): rows where repoSettingsId IS NULL. */
  getWithSettings: protectedProcedure.query(() => listScopeSettings(GLOBAL_SCOPE)),

  ...scopedSettingsProcedures(noScopeInput, async () => GLOBAL_SCOPE),

  /**
   * Set any subset of the plain global settings; omitted fields are untouched.
   * A null (or, for text, blank) value reverts that field to its default.
   */
  update: protectedProcedure.input(globalSettingsUpdateSchema).mutation(async ({ input }) => {
    await patchGlobalSettings(input);
    // Field names only: the prompt append can be tens of KB.
    log.info('Updated global settings', { fields: Object.keys(input) });
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
});
