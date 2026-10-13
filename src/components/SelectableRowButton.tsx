'use client';

import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * The clickable body of a pick-one list row (repo, issue). A real button so
 * rows are reachable and activatable by keyboard; `selected` is exposed as
 * `aria-pressed` so screen readers announce which row is chosen.
 */
export function SelectableRowButton({
  selected,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'type' | 'aria-pressed'> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'w-full text-left cursor-pointer hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        selected && 'bg-primary/10',
        className
      )}
      {...props}
    />
  );
}
