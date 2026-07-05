'use client';

import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from './CopyButton';
import { SanitizationBadge } from './SanitizationBadge';
import { formatAsJson } from './types';
import type { ContentBlock } from './types';
import { parseSanitizationInfo } from '@/lib/sanitization';

/**
 * Display for tool results (from user messages containing tool_result blocks).
 */
export function ToolResultDisplay({ results }: { results: ContentBlock[] }) {
  const [expanded, setExpanded] = useState(false);
  const getJsonText = useCallback(() => formatAsJson(results), [results]);

  // Check if any result is an error
  const hasError = results.some((r) => r.is_error);

  // Sanitizer findings attached to any of these results (see SanitizationBadge).
  // Rendered above the collapsible so the Popover trigger isn't nested inside the
  // CollapsibleTrigger button (invalid button-in-button).
  const sanitizations = results
    .map((r) => parseSanitizationInfo(r.sanitization))
    .filter((info): info is NonNullable<typeof info> => info !== null);

  return (
    <div className="group">
      {sanitizations.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {sanitizations.map((info, index) => (
            <SanitizationBadge key={index} info={info} surface="tool result" />
          ))}
        </div>
      )}
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <Card className={cn('border', hasError && 'border-red-300 dark:border-red-700')}>
          <CollapsibleTrigger className="w-full px-3 py-2 text-left flex items-center justify-between text-sm hover:bg-muted/50 rounded-t-xl">
            <div className="flex items-center gap-2">
              <Badge variant={hasError ? 'destructive' : 'secondary'}>
                Tool Result{results.length > 1 ? 's' : ''}
              </Badge>
              <span className="text-muted-foreground text-xs">
                {results.length} result{results.length > 1 ? 's' : ''}
              </span>
            </div>
            <span className="text-muted-foreground">{expanded ? '−' : '+'}</span>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="p-3 space-y-2 text-xs">
              {results.map((result, index) => (
                <div key={result.tool_use_id || index}>
                  {result.tool_use_id && (
                    <div className="text-muted-foreground mb-1 font-mono text-xs">
                      {result.tool_use_id}
                    </div>
                  )}
                  <pre
                    className={cn(
                      'p-2 rounded overflow-x-auto max-h-48 overflow-y-auto',
                      result.is_error
                        ? 'bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200'
                        : 'bg-muted'
                    )}
                  >
                    {typeof result.content === 'string'
                      ? result.content
                      : JSON.stringify(result.content, null, 2)}
                  </pre>
                </div>
              ))}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
      <div className="mt-1">
        <CopyButton getText={getJsonText} />
      </div>
    </div>
  );
}
