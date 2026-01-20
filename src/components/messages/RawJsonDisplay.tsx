'use client';

import { useState, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from './CopyButton';
import { formatAsJson } from './types';

/**
 * Display component for raw/unrecognized JSON messages.
 * Shows collapsed by default to avoid cluttering the UI.
 */
export function RawJsonDisplay({ content, label }: { content: unknown; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  const getJsonText = useCallback(() => formatAsJson(content), [content]);

  return (
    <div className="group">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <Card className="border-dashed border-amber-300 dark:border-amber-700">
          <CollapsibleTrigger className="w-full px-3 py-2 text-left flex items-center justify-between text-sm hover:bg-muted/50 rounded-t-xl">
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className="text-xs border-amber-500 text-amber-700 dark:text-amber-400"
              >
                {label || 'Raw Message'}
              </Badge>
              <span className="text-muted-foreground text-xs">Click to expand JSON</span>
            </div>
            <span className="text-muted-foreground">{expanded ? '−' : '+'}</span>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="p-3">
              <pre className="bg-muted p-2 rounded overflow-x-auto max-h-96 overflow-y-auto text-xs font-mono">
                {formatAsJson(content)}
              </pre>
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
