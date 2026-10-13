/** Styling shared by the floating usage indicators beside the transcript. */

export const USAGE_PILL_CLASS =
  'inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-background/80 backdrop-blur-sm ' +
  'border border-border/50 text-xs font-medium cursor-default select-none transition-colors ' +
  'hover:bg-muted/50';

export function getUsageColorClass(percentUsed: number): string {
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
