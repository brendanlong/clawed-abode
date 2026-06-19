'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { computeInlineDiff, diffStats, type DiffLine } from './inline-diff';

/** Cap rendered rows so a huge edit can't flood the DOM and lag the page. */
const MAX_RENDERED_LINES = 1000;

const LINE_STYLES: Record<DiffLine['type'], string> = {
  add: 'bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-200',
  remove: 'bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200',
  context: 'text-muted-foreground',
};

const SIGN: Record<DiffLine['type'], string> = {
  add: '+',
  remove: '-',
  context: ' ',
};

const HIGHLIGHT_STYLES: Record<DiffLine['type'], string> = {
  add: 'bg-green-200/70 dark:bg-green-700/50 rounded-[2px]',
  remove: 'bg-red-200/70 dark:bg-red-800/50 rounded-[2px]',
  context: '',
};

function DiffLineRow({ line }: { line: DiffLine }) {
  return (
    <div className={cn('flex', LINE_STYLES[line.type])}>
      <span className="w-4 shrink-0 select-none text-center opacity-60" aria-hidden>
        {SIGN[line.type]}
      </span>
      <span className="flex-1 whitespace-pre-wrap break-words">
        {line.segments.length === 0
          ? ' '
          : line.segments.map((seg, i) =>
              seg.highlight ? (
                <span key={i} className={HIGHLIGHT_STYLES[line.type]}>
                  {seg.value}
                </span>
              ) : (
                <span key={i}>{seg.value}</span>
              )
            )}
      </span>
    </div>
  );
}

/**
 * Renders an inline (unified) diff between two strings with line-level coloring
 * and word-level highlighting of the changed portions. Used by Edit displays in
 * place of separate "Removed"/"Added" blocks.
 */
export function InlineDiff({
  oldString,
  newString,
  className,
}: {
  oldString: string;
  newString: string;
  className?: string;
}) {
  const lines = useMemo(() => computeInlineDiff(oldString, newString), [oldString, newString]);
  const stats = useMemo(() => diffStats(lines), [lines]);

  const truncated = lines.length > MAX_RENDERED_LINES;
  const visibleLines = truncated ? lines.slice(0, MAX_RENDERED_LINES) : lines;

  return (
    <div className="overflow-hidden rounded border">
      <div className="flex items-center gap-3 border-b bg-muted/50 px-2 py-1 text-xs font-medium">
        <span className="text-green-600 dark:text-green-400">+{stats.added}</span>
        <span className="text-red-600 dark:text-red-400">-{stats.removed}</span>
      </div>
      <div className={cn('overflow-auto font-mono text-xs leading-relaxed max-h-96', className)}>
        {lines.length === 0 ? (
          <div className="px-2 py-1 text-muted-foreground italic">(no changes)</div>
        ) : (
          <>
            {visibleLines.map((line, i) => (
              <DiffLineRow key={i} line={line} />
            ))}
            {truncated && (
              <div className="border-t bg-muted/30 px-2 py-1 text-center text-muted-foreground italic">
                … {lines.length - MAX_RENDERED_LINES} more lines hidden
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
