'use client';

import { useState, useCallback } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from './CopyButton';
import { formatAsJson } from './types';
import type { MessageContent } from './types';

/**
 * Display for system init messages showing session metadata.
 */
export function SystemInitDisplay({ content }: { content: MessageContent }) {
  const [expanded, setExpanded] = useState(false);
  const getJsonText = useCallback(() => formatAsJson(content), [content]);

  return (
    <div className="group">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger className="w-full text-left flex items-center gap-2 text-sm hover:bg-muted/50 rounded p-2">
          <Badge variant="secondary">Session Started</Badge>
          <span className="text-muted-foreground text-xs">
            {content.model} · v{content.claude_code_version}
          </span>
          <span className="text-muted-foreground ml-auto">{expanded ? '−' : '+'}</span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="p-3 space-y-2 text-xs bg-muted/50 rounded mt-1">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="text-muted-foreground">Session ID:</span>
                <span className="ml-2 font-mono">{content.session_id}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Working Dir:</span>
                <span className="ml-2 font-mono">{content.cwd}</span>
              </div>
            </div>
            {content.tools && content.tools.length > 0 && (
              <div>
                <span className="text-muted-foreground">Tools:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {content.tools.map((tool) => (
                    <Badge key={tool} variant="outline" className="text-xs">
                      {tool}
                    </Badge>
                  ))}
                </div>
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
