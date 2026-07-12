'use client';

import { useMemo } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { selectUsageLimits, type UsageLimit, type UsageLimitBar } from '@/lib/usage-limits';
import { cn } from '@/lib/utils';

interface UsageLimitsIndicatorProps {
  /** Raw limits from claude.getUsageLimits; null/undefined when unconfigured or failed. */
  limits: UsageLimit[] | null | undefined;
  /** The session's active model (from token usage stats), for picking the weekly limit. */
  model: string | null;
  className?: string;
}

/**
 * Color follows the same thresholds as the context indicator, bumped to the
 * API's own severity when it is more urgent than the raw percentage.
 */
function getBarColorClass(bar: UsageLimitBar): string {
  if (bar.severity === 'exceeded' || bar.percent >= 90) {
    return 'text-red-600 dark:text-red-400';
  }
  if (bar.severity === 'warning' || bar.percent >= 75) {
    return 'text-orange-600 dark:text-orange-400';
  }
  if (bar.percent >= 50) {
    return 'text-yellow-600 dark:text-yellow-400';
  }
  return 'text-muted-foreground';
}

function formatResetTime(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatTooltipContent(bars: UsageLimitBar[]): string {
  return bars
    .map((bar) => {
      const reset = formatResetTime(bar.resetsAt);
      return `${bar.label} limit: ${Math.round(bar.percent)}% used${reset ? ` (resets ${reset})` : ''}`;
    })
    .join('\n');
}

/**
 * Displays claude.ai subscription usage limits (session + weekly) as small
 * bars next to the context usage indicator. Renders nothing when no claude.ai
 * session cookie is configured or the fetch failed (issue #379).
 */
export function UsageLimitsIndicator({ limits, model, className }: UsageLimitsIndicatorProps) {
  const bars = useMemo(() => (limits ? selectUsageLimits(limits, model) : []), [limits, model]);

  if (bars.length === 0) {
    return null;
  }

  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <div
            className={cn(
              'inline-flex items-center gap-2 px-2 py-1 rounded-md',
              'bg-background/80 backdrop-blur-sm border border-border/50',
              'text-xs font-medium cursor-default select-none',
              'transition-colors hover:bg-muted/50',
              className
            )}
          >
            {bars.map((bar) => (
              <span
                key={bar.key}
                className={cn('inline-flex items-center gap-1', getBarColorClass(bar))}
              >
                <span className="w-8 h-1.5 rounded-full bg-current/25 overflow-hidden">
                  <span
                    className="block h-full rounded-full bg-current"
                    style={{ width: `${Math.min(100, Math.max(0, bar.percent))}%` }}
                  />
                </span>
                <span>
                  {Math.round(bar.percent)}% {bar.key === 'session' ? 'session' : 'week'}
                </span>
              </span>
            ))}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="whitespace-pre-line text-left">
          {formatTooltipContent(bars)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
