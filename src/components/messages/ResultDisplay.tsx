'use client';

import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from './CopyButton';
import { formatAsJson } from './types';
import type { MessageContent } from './types';

/**
 * Display for result messages (turn completion with cost/usage info).
 */
export function ResultDisplay({ content }: { content: MessageContent }) {
  const [expanded, setExpanded] = useState(false);
  const getJsonText = useCallback(() => formatAsJson(content), [content]);

  const formatCost = (cost?: number) => {
    if (cost === undefined) return 'N/A';
    return `$${cost.toFixed(4)}`;
  };

  const formatTokens = (tokens?: number) => {
    if (tokens === undefined) return 'N/A';
    return tokens.toLocaleString();
  };

  return (
    <div className="group">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger className="w-full text-left flex items-center gap-2 text-sm hover:bg-muted/50 rounded p-2">
          <Badge
            variant="outline"
            className={cn(
              content.subtype === 'success'
                ? 'border-green-500 text-green-700 dark:text-green-400'
                : 'border-red-500 text-red-700 dark:text-red-400'
            )}
          >
            {content.subtype === 'success' ? 'Turn Complete' : 'Error'}
          </Badge>
          <span className="text-muted-foreground text-xs">
            {formatCost(content.total_cost_usd)} · {content.num_turns} turn
            {content.num_turns !== 1 ? 's' : ''}
          </span>
          <span className="text-muted-foreground ml-auto">{expanded ? '−' : '+'}</span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="p-3 space-y-2 text-xs bg-muted/50 rounded mt-1">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="text-muted-foreground">Duration:</span>
                <span className="ml-2">
                  {content.duration_ms ? `${(content.duration_ms / 1000).toFixed(1)}s` : 'N/A'}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Cost:</span>
                <span className="ml-2">{formatCost(content.total_cost_usd)}</span>
              </div>
            </div>
            {content.usage && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="text-muted-foreground">Input tokens:</span>
                  <span className="ml-2">{formatTokens(content.usage.input_tokens)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Output tokens:</span>
                  <span className="ml-2">{formatTokens(content.usage.output_tokens)}</span>
                </div>
                {content.usage.cache_read_input_tokens !== undefined &&
                  content.usage.cache_read_input_tokens > 0 && (
                    <div>
                      <span className="text-muted-foreground">Cache read:</span>
                      <span className="ml-2">
                        {formatTokens(content.usage.cache_read_input_tokens)}
                      </span>
                    </div>
                  )}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
      <div className="mt-1">
        <CopyButton getText={getJsonText} />
      </div>
    </div>
  );
}
