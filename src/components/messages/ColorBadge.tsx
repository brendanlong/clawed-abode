import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';

// Full literal class strings so Tailwind's scanner picks them up.
const COLOR_CLASSES = {
  green: 'border-green-500 text-green-700 dark:text-green-400',
  blue: 'border-blue-500 text-blue-700 dark:text-blue-400',
  yellow: 'border-yellow-500 text-yellow-700 dark:text-yellow-400',
  amber: 'border-amber-500 text-amber-700 dark:text-amber-400',
  red: 'border-red-500 text-red-700 dark:text-red-400',
  purple: 'border-purple-500 text-purple-700 dark:text-purple-400',
  indigo: 'border-indigo-500 text-indigo-700 dark:text-indigo-400',
  cyan: 'border-cyan-500 text-cyan-700 dark:text-cyan-400',
} as const;

export type BadgeColor = keyof typeof COLOR_CLASSES;

/** Outlined badge tinted with one accent color, as used across the tool displays. */
export function ColorBadge({ color, children }: { color: BadgeColor; children: ReactNode }) {
  return (
    <Badge variant="outline" className={COLOR_CLASSES[color]}>
      {children}
    </Badge>
  );
}
