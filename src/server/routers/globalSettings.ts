import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import { DEFAULT_SYSTEM_PROMPT } from '../services/claude-runner';

const log = createLogger('globalSettings');

// The singleton ID for global settings
const GLOBAL_SETTINGS_ID = 'global';

export const globalSettingsRouter = router({
  /**
   * Get the default system prompt (built-in)
   * Used to pre-populate the override field in the UI
   */
  getDefaultSystemPrompt: protectedProcedure.query(() => {
    return { defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT };
  }),

  /**
   * Get the current global settings
   * Returns defaults if no settings exist yet
   */
  get: protectedProcedure.query(async () => {
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
  }),

  /**
   * Set the system prompt override
   * Pass null to clear the override
   */
  setSystemPromptOverride: protectedProcedure
    .input(
      z.object({
        systemPromptOverride: z.string().max(50000).nullable(),
        systemPromptOverrideEnabled: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      const override = input.systemPromptOverride?.trim() || null;

      await prisma.globalSettings.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        create: {
          id: GLOBAL_SETTINGS_ID,
          systemPromptOverride: override,
          systemPromptOverrideEnabled: input.systemPromptOverrideEnabled,
        },
        update: {
          systemPromptOverride: override,
          systemPromptOverrideEnabled: input.systemPromptOverrideEnabled,
        },
      });

      log.info('Set system prompt override', {
        hasOverride: override !== null,
        enabled: input.systemPromptOverrideEnabled,
      });

      return { success: true };
    }),

  /**
   * Set the system prompt append content
   * Pass null or empty string to clear
   */
  setSystemPromptAppend: protectedProcedure
    .input(
      z.object({
        systemPromptAppend: z.string().max(50000).nullable(),
      })
    )
    .mutation(async ({ input }) => {
      const append = input.systemPromptAppend?.trim() || null;

      await prisma.globalSettings.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        create: {
          id: GLOBAL_SETTINGS_ID,
          systemPromptAppend: append,
        },
        update: {
          systemPromptAppend: append,
        },
      });

      log.info('Set system prompt append', {
        hasAppend: append !== null,
      });

      return { success: true };
    }),

  /**
   * Toggle the system prompt override enabled state
   */
  toggleSystemPromptOverrideEnabled: protectedProcedure
    .input(
      z.object({
        enabled: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      await prisma.globalSettings.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        create: {
          id: GLOBAL_SETTINGS_ID,
          systemPromptOverrideEnabled: input.enabled,
        },
        update: {
          systemPromptOverrideEnabled: input.enabled,
        },
      });

      log.info('Toggled system prompt override', { enabled: input.enabled });

      return { success: true };
    }),
});
