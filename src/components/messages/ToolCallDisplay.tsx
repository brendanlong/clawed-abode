'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { processTerminalOutput, isTerminalOutput } from '@/lib/terminal-output';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import type { ToolCall } from './types';

/**
 * Generic display for tool calls.
 * Shows tool name, optional description, and collapsible input/output.
 */
export function ToolCallDisplay({ tool }: { tool: ToolCall }) {
  const hasOutput = tool.output !== undefined;

  // Extract description from input if present (e.g., Bash tool)
  const inputObj = tool.input as Record<string, unknown> | undefined;
  const description = inputObj?.description as string | undefined;

  // Process terminal output (ANSI codes, progress bars) for Bash commands
  const processedOutput = useMemo(() => {
    if (typeof tool.output !== 'string') {
      return null;
    }
    // Only process if it looks like terminal output
    if (isTerminalOutput(tool.output)) {
      return processTerminalOutput(tool.output);
    }
    return null;
  }, [tool.output]);

  return (
    <ToolDisplayWrapper
      tool={tool}
      title={tool.name}
      subtitle={
        description ? (
          <div className="text-muted-foreground text-xs mt-1 truncate">{description}</div>
        ) : undefined
      }
      doneBadge={null}
    >
      <div>
        <div className="text-muted-foreground mb-1">Input:</div>
        <pre className="bg-muted p-2 rounded overflow-x-auto">
          {tool.name === 'Bash' && inputObj?.command
            ? String(inputObj.command)
            : JSON.stringify(tool.input, null, 2)}
        </pre>
      </div>
      {hasOutput && (
        <div>
          <div className="text-muted-foreground mb-1">Output:</div>
          {processedOutput ? (
            <pre
              className={cn(
                'p-2 rounded overflow-x-auto max-h-48 overflow-y-auto terminal-output',
                tool.is_error ? 'bg-red-50 dark:bg-red-950' : 'bg-muted'
              )}
              dangerouslySetInnerHTML={{ __html: processedOutput }}
            />
          ) : (
            <pre
              className={cn(
                'p-2 rounded overflow-x-auto max-h-48 overflow-y-auto',
                tool.is_error
                  ? 'bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200'
                  : 'bg-muted'
              )}
            >
              {typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </ToolDisplayWrapper>
  );
}
