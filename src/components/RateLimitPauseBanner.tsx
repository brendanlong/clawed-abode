'use client';

import { PauseCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNowTick } from '@/hooks/useNowTick';
import { describeLimitType, formatTimeUntil, type RateLimitHold } from '@/lib/rate-limit';

interface RateLimitPauseBannerProps {
  hold: RateLimitHold;
  /** How many of this session's prompts are parked behind the pause. */
  queuedCount: number;
  /** Discard the queued prompts, returning their text to the composer. */
  onClearQueue: () => void;
  isClearing: boolean;
}

/**
 * Shown above the composer while a session is paused for a subscription rate
 * limit. Sends still work — they queue — so this explains where they went and
 * offers the only way to take them back.
 */
export function RateLimitPauseBanner({
  hold,
  queuedCount,
  onClearQueue,
  isClearing,
}: RateLimitPauseBannerProps) {
  const now = useNowTick();
  const releaseTime = new Date(hold.untilMs).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  const reason =
    hold.reason === 'rejected'
      ? `Your ${describeLimitType(hold.limitType)} is used up`
      : `Your ${describeLimitType(hold.limitType)} is ${Math.round(hold.utilization ?? 0)}% used`;

  return (
    <div className="border-t bg-amber-50 px-4 py-2 text-sm dark:bg-amber-950/40">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0">
            <p className="font-medium">Paused until {releaseTime}</p>
            <p className="text-muted-foreground">
              {reason}. Work resumes automatically {formatTimeUntil(hold.untilMs, now)}
              {queuedCount > 0 && ` — ${queuedCount} prompt${queuedCount === 1 ? '' : 's'} queued`}.
            </p>
          </div>
        </div>
        {queuedCount > 0 && (
          <Button variant="ghost" size="sm" onClick={onClearQueue} disabled={isClearing}>
            Clear queue
          </Button>
        )}
      </div>
    </div>
  );
}
