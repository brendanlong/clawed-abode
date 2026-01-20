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

  lines.push(`Context window: ${formatTokenCount(stats.contextWindow)}`);

  if (stats.model) {
    lines.push(`Model: ${stats.model}`);
  }

  return lines.join('\n');
}

/**
 * Displays estimated context usage as a percentage indicator.
 * Shows in the bottom-right corner of the messages area.
 */
export function ContextUsageIndicator({ stats, className }: ContextUsageIndicatorProps) {
  // Don't show if there's no usage yet
  if (!stats || stats.totalTokens === 0) {
    return null;
  }

  const colorClass = getUsageColorClass(stats.percentUsed);

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
              <path
                d={describeArc(12, 12, 8, 0, (stats.percentUsed / 100) * 360)}
                fill="none"
                strokeWidth="3"
              />
            </svg>
            <span>{formatPercentage(stats.percentUsed)} context</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="whitespace-pre-line text-left">
          {formatTooltipContent(stats)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Create an SVG arc path for the progress indicator
 */
function polarToCartesian(
  centerX: number,
  centerY: number,
  radius: number,
  angleInDegrees: number
): { x: number; y: number } {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function describeArc(
  x: number,
  y: number,
  radius: number,
  startAngle: number,
  endAngle: number
): string {
  // Handle edge case of full circle
  if (endAngle >= 360) {
    endAngle = 359.999;
  }

  const start = polarToCartesian(x, y, radius, endAngle);
  const end = polarToCartesian(x, y, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';

  return ['M', start.x, start.y, 'A', radius, radius, 0, largeArcFlag, 0, end.x, end.y].join(' ');
}
