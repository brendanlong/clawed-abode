'use client';

import { useState } from 'react';
import { Brain } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { MarkdownContent } from '@/components/MarkdownContent';

/**
 * Collapsible display for Claude's extended-thinking content.
 *
 * Multiple thinking blocks within a single message are coalesced by the caller
 * and rendered here as one section so the UI shows a single "Thinking" block
 * rather than a stream of separate bubbles.
 */
export function ThinkingDisplay({
  thinking,
  redacted = false,
  defaultExpanded = false,
}: {
  thinking: string;
  redacted?: boolean;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="mt-2">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground transition-colors">
        <Brain className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="italic">Thinking{redacted ? ' (redacted)' : ''}</span>
        <span className="ml-auto">{expanded ? '−' : '+'}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 border-l-2 border-muted pl-3 text-sm text-muted-foreground italic">
          {redacted ? (
            <span>Claude&apos;s thinking for this step was encrypted and is not shown.</span>
          ) : (
            <MarkdownContent content={thinking} />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
