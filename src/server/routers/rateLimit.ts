import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { createLogger } from '@/lib/logger';
import { thresholdSchema } from '@/lib/rate-limit';
import { getRateLimitReadings, loadGlobalPausePolicy } from '../services/rate-limit-state';
import { recomputeRateLimitHolds } from '../services/claude-runner';
import { countQueuedPrompts } from '../services/prompt-queue';
import { patchGlobalSettings } from '../services/global-settings';

const log = createLogger('rateLimit');

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
      await patchGlobalSettings({
        rateLimitPauseEnabled: input.enabled,
        rateLimitPauseThreshold: input.threshold,
      });
      log.info('Set rate-limit pause defaults', input);
      await recomputeRateLimitHolds();
      return { success: true };
    }),
});
