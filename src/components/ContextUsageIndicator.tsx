'use client';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatTokenCount, formatPercentage, type TokenUsageStats } from '@/lib/token-estimation';
import { cn } from '@/lib/utils';

interface ContextUsageIndicatorProps {
  stats: TokenUsageStats | null | undefined;
  className?: string;
}

/**
 * Get color classes based on percentage used
 */
function getUsageColorClass(percentUsed: number): string {
  if (percentUsed >= 90) {
    return 'text-red-600 dark:text-red-400';
  }
  if (percentUsed >= 75) {
    return 'text-orange-600 dark:text-orange-400';
  }
  if (percentUsed >= 50) {
    return 'text-yellow-600 dark:text-yellow-400';
  }
  return 'text-muted-foreground';
}

/**
 * Format the detailed tooltip content
 */
function formatTooltipContent(stats: TokenUsageStats): string {
  const lines: string[] = [];

  lines.push(`Input: ${formatTokenCount(stats.inputTokens)} tokens`);
  lines.push(`Output: ${formatTokenCount(stats.outputTokens)} tokens`);

  if (stats.cacheReadTokens > 0) {
    lines.push(`Cache read: ${formatTokenCount(stats.cacheReadTokens)}`);
  }

  if (stats.cacheCreationTokens > 0) {
    lines.push(`Cache creation: ${formatTokenCount(stats.cacheCreationTokens)}`);
  }

  lines.push(`Context window: ${formatTokenCount(stats.contextWindow)}`);

  if (stats.totalCostUsd > 0) {
    lines.push(`Cost: $${stats.totalCostUsd.toFixed(4)}`);
  }

  if (stats.model) {
    lines.push(`Model: ${stats.model}`);
  }

  return lines.join('\n');
}

/**
 * Displays estimated context usage as a percentage indicator with optional cost.
 * Shows in the bottom-right corner of the messages area.
 */
export function ContextUsageIndicator({ stats, className }: ContextUsageIndicatorProps) {
  // Don't show if there's no usage yet
  if (!stats || stats.totalTokens === 0) {
    return null;
  }

  const colorClass = getUsageColorClass(stats.percentUsed);
  const costLabel =
    stats.totalCostUsd === 0
      ? null
      : stats.totalCostUsd < 0.01
        ? '<$0.01'
        : `$${stats.totalCostUsd.toFixed(2)}`;

  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <div
            className={cn(
              'inline-flex items-center gap-1.5 px-2 py-1 rounded-md',
              'bg-background/80 backdrop-blur-sm border border-border/50',
              'text-xs font-medium cursor-default select-none',
              'transition-colors hover:bg-muted/50',
              colorClass,
              className
            )}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-3.5 h-3.5"
            >
              <circle cx="12" cy="12" r="10" className="opacity-30" />
              <circle
                cx="12"
                cy="12"
                r="8"
                strokeWidth="3"
                pathLength={100}
                strokeDasharray={`${stats.percentUsed} 100`}
                transform="rotate(-90 12 12)"
              />
            </svg>
            <span>
              {formatPercentage(stats.percentUsed)} context
              {costLabel && <span className="ml-1 opacity-70">{costLabel}</span>}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="whitespace-pre-line text-left">
          {formatTooltipContent(stats)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
