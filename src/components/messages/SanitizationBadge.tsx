'use client';

import { ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { SanitizationInfo } from '@/lib/sanitization';

/**
 * Small amber badge surfacing that the input sanitizer filtered (or flagged)
 * hidden/unsafe content on the message it is attached to. Click to reveal the
 * sanitizer's warnings — this is purely informational; the model already got the
 * cleaned text plus a recovery note.
 */
export function SanitizationBadge({
  info,
  surface,
  className,
}: {
  info: SanitizationInfo;
  /** What the finding applies to, for the popover copy. */
  surface: 'message' | 'tool result';
  className?: string;
}) {
  const label = info.removed ? 'Hidden content removed' : 'Suspicious content flagged';
  const details = info.warnings.length > 0 ? info.warnings : info.found;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-400 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200 dark:hover:bg-amber-900',
            className
          )}
        >
          <ShieldAlert className="h-3 w-3" />
          <span>{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-2 text-xs">
        <p className="font-semibold text-amber-800 dark:text-amber-200">{label}</p>
        <p className="text-muted-foreground">
          {info.removed
            ? `Hidden or invisible content was automatically removed from this ${surface} before Claude saw it.`
            : `The sanitizer flagged potentially unsafe content in this ${surface} (left in place, but worth reviewing).`}
        </p>
        {details.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
            {details.map((detail, index) => (
              <li key={index}>{detail}</li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
