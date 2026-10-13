'use client';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useNowTick } from '@/hooks/useNowTick';
import { formatTimeUntil } from '@/lib/rate-limit';
import type { SessionSubscriptionUsage, UsageBar } from '@/lib/usage';
import { cn } from '@/lib/utils';
import { getUsageColorClass, USAGE_PILL_CLASS } from './usage-indicator-styles';

interface SubscriptionUsageIndicatorProps {
  usage: SessionSubscriptionUsage | null | undefined;
  className?: string;
}

function barPercent(bar: UsageBar): number {
  return bar.exhausted ? 100 : Math.round(bar.percentUsed ?? 0);
}

function describeBar(bar: UsageBar, nowMs: number): string {
  const used = bar.exhausted
    ? 'used up'
    : bar.percentUsed === null
      ? 'unknown'
      : `${Math.round(bar.percentUsed)}% used`;
  const resets =
    bar.resetsAtMs === null ? '' : `, resets ${formatTimeUntil(bar.resetsAtMs, nowMs)}`;
  return `${bar.label}: ${used}${resets}`;
}

function MiniBar({ bar }: { bar: UsageBar }) {
  const percent = barPercent(bar);
  return (
    <span className={cn('inline-flex items-center gap-1', getUsageColorClass(percent))}>
      <span className="opacity-70">{bar.label}</span>
      <span
        role="meter"
        aria-label={bar.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="relative h-1.5 w-8 overflow-hidden rounded-full bg-current/20"
      >
        <span className="absolute inset-y-0 left-0 bg-current" style={{ width: `${percent}%` }} />
      </span>
      <span>{bar.percentUsed === null && !bar.exhausted ? '?' : `${percent}%`}</span>
    </span>
  );
}

/**
 * Subscription usage beside the context indicator: the 5-hour window, and the
 * weekly window scoped to the session's model if the plan has one, else the
 * all-models weekly window. The tooltip details every window, with reset times.
 */
export function SubscriptionUsageIndicator({ usage, className }: SubscriptionUsageIndicatorProps) {
  const now = useNowTick();
  if (!usage) return null;
  const weekly = usage.weeklyModel ?? usage.weeklyAllModels;
  const bars = [usage.fiveHour, weekly].filter((bar): bar is UsageBar => bar !== null);
  if (bars.length === 0) return null;

  const details = [usage.fiveHour, usage.weeklyModel, usage.weeklyAllModels]
    .filter((bar): bar is UsageBar => bar !== null)
    .map((bar) => describeBar(bar, now));

  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <div className={cn(USAGE_PILL_CLASS, 'gap-2.5', className)}>
            {bars.map((bar) => (
              <MiniBar key={bar.label} bar={bar} />
            ))}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="whitespace-pre-line text-left">
          {details.join('\n')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
