'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { MarkdownContent } from '@/components/MarkdownContent';
import type { ToolCall } from './types';

interface SkillInput {
  skill: string;
  args?: string;
}

function SkillIcon() {
  return (
    <svg
      className="w-4 h-4 text-indigo-600 dark:text-indigo-400 flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"
      />
    </svg>
  );
}

/**
 * Specialized display for Skill tool calls.
 * Shows the skill name, arguments, and output.
 */
export function SkillDisplay({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const hasOutput = tool.output !== undefined;
  const isPending = !hasOutput;

  const input = tool.input as SkillInput | undefined;
  const skillName = input?.skill ?? 'Unknown';
  const args = input?.args;

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
                <SkillIcon />
                <span className="font-mono text-primary">Skill</span>
                <Badge
                  variant="outline"
                  className="text-xs border-indigo-500 text-indigo-700 dark:text-indigo-400"
                >
                  /{skillName}
                </Badge>
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
              {args && (
                <div className="text-muted-foreground text-xs mt-1 truncate font-mono">{args}</div>
              )}
            </div>
            <span className="text-muted-foreground ml-2 flex-shrink-0">{expanded ? '−' : '+'}</span>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="p-3 space-y-3 text-xs">
              {/* Args section */}
              {args && (
                <div>
                  <div className="text-muted-foreground mb-1">Arguments:</div>
                  <code className="bg-muted px-2 py-1 rounded text-sm">{args}</code>
                </div>
              )}

              {/* Output section */}
              {hasOutput && (
                <div>
                  <div className="text-muted-foreground mb-1">Output:</div>
                  {tool.is_error ? (
                    <pre className="bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200 p-2 rounded overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap break-words">
                      {typeof tool.output === 'string'
                        ? tool.output
                        : JSON.stringify(tool.output, null, 2)}
                    </pre>
                  ) : typeof tool.output === 'string' ? (
                    <div className="bg-muted rounded p-3 max-h-96 overflow-y-auto prose prose-sm dark:prose-invert max-w-none">
                      <MarkdownContent content={tool.output} />
                    </div>
                  ) : (
                    <pre className="bg-muted p-2 rounded overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap text-xs">
                      {JSON.stringify(tool.output, null, 2)}
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
