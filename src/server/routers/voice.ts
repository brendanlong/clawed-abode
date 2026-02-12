import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';

const GLOBAL_SETTINGS_ID = 'global';

export const voiceRouter = router({
  /**
   * Get voice configuration status.
   * Returns whether voice features are available (OpenAI key configured)
   * and whether text transformation is available (Anthropic API key configured).
   */
  getConfig: protectedProcedure.query(async () => {
    const settings = await prisma.globalSettings.findUnique({
      where: { id: GLOBAL_SETTINGS_ID },
      select: { openaiApiKey: true, claudeApiKey: true },
    });

    return {
      enabled: settings?.openaiApiKey !== null && settings?.openaiApiKey !== undefined,
      hasAnthropicKey: settings?.claudeApiKey !== null && settings?.claudeApiKey !== undefined,
    };
  }),
});
