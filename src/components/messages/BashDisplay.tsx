'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { processTerminalOutput, isTerminalOutput } from '@/lib/terminal-output';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import type { ToolCall } from './types';

interface BashInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

function TerminalIcon() {
  return (
    <svg
      className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z"
      />
    </svg>
  );
}

/**
 * Specialized display for Bash tool calls.
 * Shows the command, description, and formatted terminal output with ANSI support.
 */
export function BashDisplay({ tool }: { tool: ToolCall }) {
  const hasOutput = tool.output !== undefined;

  const input = tool.input as BashInput | undefined;
  const command = input?.command ?? '';
  const description = input?.description;
  const isBackground = input?.run_in_background ?? false;

  // Process terminal output (ANSI codes, progress bars)
  const processedOutput = useMemo(() => {
    if (typeof tool.output !== 'string') return null;
    if (isTerminalOutput(tool.output)) {
      return processTerminalOutput(tool.output);
    }
    return null;
  }, [tool.output]);

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<TerminalIcon />}
      title="Bash"
      headerContent={
        isBackground ? (
          <Badge variant="outline" className="text-xs">
            background
          </Badge>
        ) : null
      }
      subtitle={
        description ? (
          <div className="text-muted-foreground text-xs mt-1 truncate">{description}</div>
        ) : undefined
      }
    >
      {/* Command section */}
      <div>
        <div className="text-muted-foreground mb-1">Command:</div>
        <pre className="bg-zinc-900 dark:bg-zinc-950 text-green-400 p-2 rounded overflow-x-auto whitespace-pre-wrap break-words text-sm font-mono">
          <span className="text-gray-500 select-none">$ </span>
          {command}
        </pre>
      </div>

      {/* Output section */}
      {hasOutput && (
        <div>
          <div className="text-muted-foreground mb-1">Output:</div>
          {processedOutput ? (
            <pre
              className={cn(
                'p-2 rounded overflow-x-auto max-h-96 overflow-y-auto terminal-output font-mono text-sm',
                tool.is_error ? 'bg-red-50 dark:bg-red-950' : 'bg-muted'
              )}
              dangerouslySetInnerHTML={{ __html: processedOutput }}
            />
          ) : (
            <pre
              className={cn(
                'p-2 rounded overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-mono text-sm',
                tool.is_error
                  ? 'bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200'
                  : 'bg-muted'
              )}
            >
              {typeof tool.output === 'string'
                ? tool.output || '(no output)'
                : JSON.stringify(tool.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </ToolDisplayWrapper>
  );
}
