'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { MarkdownContent } from '@/components/MarkdownContent';
import type { ToolCall } from './types';

interface ExitPlanModeInput {
  allowedPrompts?: Array<{
    tool: string;
    prompt: string;
  }>;
  pushToRemote?: boolean;
  remoteSessionId?: string;
  remoteSessionTitle?: string;
  remoteSessionUrl?: string;
}

// Clipboard/plan icon component
function ClipboardIcon() {
  return (
    <svg
      className="w-4 h-4 text-purple-600 dark:text-purple-400 flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z"
      />
    </svg>
  );
}

/**
 * Specialized display for ExitPlanMode tool calls.
 * Shows the plan approval status and any allowed prompts.
 */
export function ExitPlanModeDisplay({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(true);
  const hasOutput = tool.output !== undefined;
  const isPending = !hasOutput;

  const inputObj = tool.input as ExitPlanModeInput | undefined;
  const allowedPrompts = inputObj?.allowedPrompts ?? [];

  // Parse the output - it's typically a string like "Exit plan mode?"
  const outputText =
    typeof tool.output === 'string'
      ? tool.output
      : tool.output
        ? JSON.stringify(tool.output, null, 2)
        : '';

  return (
    <div className="group">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <Card
          className={cn(
            'mt-2',
            tool.is_error && 'border-red-300 dark:border-red-700',
            isPending && 'border-yellow-300 dark:border-yellow-700',
            !isPending && !tool.is_error && 'border-purple-300 dark:border-purple-700'
          )}
        >
          <CollapsibleTrigger className="w-full px-3 py-2 text-left flex items-center justify-between text-sm hover:bg-muted/50 rounded-t-xl">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <ClipboardIcon />
                <span className="font-mono text-primary">Plan Complete</span>
                {isPending && (
                  <Badge
                    variant="outline"
                    className="text-xs border-yellow-500 text-yellow-700 dark:text-yellow-400"
                  >
                    Awaiting approval...
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
                    className="text-xs border-purple-500 text-purple-700 dark:text-purple-400"
                  >
                    Ready for review
                  </Badge>
                )}
              </div>
              <div className="text-muted-foreground text-xs mt-1">
                Claude has finished planning and is ready for your review
              </div>
            </div>
            <span className="text-muted-foreground ml-2 flex-shrink-0">{expanded ? '−' : '+'}</span>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="p-3 space-y-3 text-xs">
              {/* Output/Status section */}
              {hasOutput && outputText && (
                <div>
                  <div className="text-muted-foreground mb-1">Status:</div>
                  <div className="bg-muted rounded p-2">
                    <MarkdownContent content={outputText} />
                  </div>
                </div>
              )}

              {/* Allowed prompts section */}
              {allowedPrompts.length > 0 && (
                <div>
                  <div className="text-muted-foreground mb-1">Requested permissions:</div>
                  <ul className="bg-muted rounded p-2 space-y-1">
                    {allowedPrompts.map((prompt, index) => (
                      <li key={index} className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          {prompt.tool}
                        </Badge>
                        <span>{prompt.prompt}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Remote session info */}
              {inputObj?.pushToRemote && inputObj.remoteSessionUrl && (
                <div>
                  <div className="text-muted-foreground mb-1">Remote session:</div>
                  <a
                    href={inputObj.remoteSessionUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {inputObj.remoteSessionTitle || inputObj.remoteSessionUrl}
                  </a>
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
  );
}
