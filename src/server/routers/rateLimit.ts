import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import { MAX_PAUSE_THRESHOLD, MIN_PAUSE_THRESHOLD } from '@/lib/rate-limit';
import { GLOBAL_SETTINGS_ID } from '../services/settings-scope';
import { getRateLimitReadings, loadGlobalPausePolicy } from '../services/rate-limit-state';
import { recomputeRateLimitHolds } from '../services/claude-runner';
import { countQueuedPrompts } from '../services/prompt-queue';

const log = createLogger('rateLimit');

export const thresholdSchema = z.number().int().min(MIN_PAUSE_THRESHOLD).max(MAX_PAUSE_THRESHOLD);

export const rateLimitRouter = router({
  /**
   * Global pause defaults plus the account-wide window state behind them. The
   * readings are shared by every session; how each session reacts is its own
   * resolved policy (see doc/rate-limit-pause.md).
   */
  getStatus: protectedProcedure.query(async () => {
    const [policy, queuedPrompts] = await Promise.all([
      loadGlobalPausePolicy(),
      countQueuedPrompts(),
    ]);
    return { policy, readings: getRateLimitReadings(), queuedPrompts };
  }),

  /**
   * Set the defaults sessions inherit. Recomputes holds immediately so turning the
   * pause on mid-window parks work right away rather than at the next reading.
   */
  setDefaults: protectedProcedure
    .input(z.object({ enabled: z.boolean(), threshold: thresholdSchema }))
    .mutation(async ({ input }) => {
      const patch = {
        rateLimitPauseEnabled: input.enabled,
        rateLimitPauseThreshold: input.threshold,
      };
      await prisma.globalSettings.upsert({
        where: { id: GLOBAL_SETTINGS_ID },
        create: { id: GLOBAL_SETTINGS_ID, ...patch },
        update: patch,
      });
      log.info('Set rate-limit pause defaults', input);
      await recomputeRateLimitHolds();
      return { success: true };
    }),
});
