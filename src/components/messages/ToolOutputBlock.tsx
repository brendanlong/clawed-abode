'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { processTerminalOutput, isTerminalOutput } from '@/lib/terminal-output';

/**
 * Stringify a tool's output for display: raw string passes through, anything
 * else is pretty-printed JSON. Shared by every tool-output `<pre>` so the
 * behavior can't drift between displays.
 */
export function stringifyToolOutput(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output, null, 2);
}

interface ToolOutputBlockProps {
  /**
   * Label shown above the output (e.g. "Output:", "Result:", "Response:").
   * Omit to render just the `<pre>` with no heading.
   */
  label?: string;
  /** The tool output — a string or arbitrary JSON-serializable value. */
  output: unknown;
  /** Renders the error styling (red background/text) when true. */
  isError?: boolean;
  /** Tailwind max-height class for the scroll area. Defaults to `max-h-96`. */
  maxHeight?: string;
  /** Wraps long lines (`whitespace-pre-wrap break-words`) instead of scrolling horizontally. */
  wrap?: boolean;
  /**
   * Renders ANSI/terminal output (colors, progress-bar carriage returns) as
   * sanitized HTML when the output looks like terminal output. Only meaningful
   * for string output.
   */
  terminal?: boolean;
  /** Extra classes for the label element. */
  labelClassName?: string;
  /** Extra classes for the `<pre>` element (e.g. text size / font). */
  preClassName?: string;
}

/**
 * Shared tool-output block: a label plus a `<pre>` that switches between the
 * error style (`bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200`) and
 * the neutral `bg-muted` style. Optionally renders ANSI/terminal output as
 * sanitized HTML. Extracted from ~14 near-identical copies across the tool
 * display components so the styling stays in one place.
 */
export function ToolOutputBlock({
  label,
  output,
  isError = false,
  maxHeight = 'max-h-96',
  wrap = false,
  terminal = false,
  labelClassName,
  preClassName,
}: ToolOutputBlockProps) {
  const processedTerminal = useMemo(() => {
    if (!terminal || typeof output !== 'string') return null;
    return isTerminalOutput(output) ? processTerminalOutput(output) : null;
  }, [terminal, output]);

  const baseClasses = cn(
    'p-2 rounded overflow-x-auto overflow-y-auto',
    maxHeight,
    wrap && 'whitespace-pre-wrap break-words',
    preClassName
  );

  return (
    <div>
      {label !== undefined && (
        <div className={cn('text-muted-foreground mb-1', labelClassName)}>{label}</div>
      )}
      {processedTerminal !== null ? (
        <pre
          className={cn(
            baseClasses,
            'terminal-output',
            isError ? 'bg-red-50 dark:bg-red-950' : 'bg-muted'
          )}
          dangerouslySetInnerHTML={{ __html: processedTerminal }}
        />
      ) : (
        <pre
          className={cn(
            baseClasses,
            isError ? 'bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200' : 'bg-muted'
          )}
        >
          {stringifyToolOutput(output)}
        </pre>
      )}
    </div>
  );
}
