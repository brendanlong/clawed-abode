'use client';

import { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { processTerminalOutput, isTerminalOutput } from '@/lib/terminal-output';
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
  const [expanded, setExpanded] = useState(false);
  const hasOutput = tool.output !== undefined;
  const isPending = !hasOutput;

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
    <div className="group">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <Card
          className={cn(
            'mt-2',
            tool.is_error && 'border-red-300 dark:border-red-700',
            isPending && 'border-yellow-300 dark:border-yellow-700'
          )}
        >
          <CollapsibleTrigger className="w-full px-3 py-2 text-left flex items-center justify-between text-sm hover:bg-muted/50 rounded-t-xl">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <TerminalIcon />
                <span className="font-mono text-primary">Bash</span>
                {isBackground && (
                  <Badge variant="outline" className="text-xs">
                    background
                  </Badge>
                )}
                {isPending && (
                  <Badge
                    variant="outline"
                    className="text-xs border-yellow-500 text-yellow-700 dark:text-yellow-400"
                  >
                    Running...
                  </Badge>
                )}
                {tool.is_error && (
                  <Badge variant="destructive" className="text-xs">
                    Error
                  </Badge>
                )}
                {hasOutput && !tool.is_error && (
                  <Badge
                    variant="outline"
                    className="text-xs border-green-500 text-green-700 dark:text-green-400"
                  >
                    Done
                  </Badge>
                )}
              </div>
              {description && (
                <div className="text-muted-foreground text-xs mt-1 truncate">{description}</div>
              )}
            </div>
            <span className="text-muted-foreground ml-2 flex-shrink-0">{expanded ? '−' : '+'}</span>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="p-3 space-y-3 text-xs">
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
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
  );
}
