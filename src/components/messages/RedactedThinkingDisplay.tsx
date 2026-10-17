'use client';

import { useState } from 'react';
import { Brain } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

export function RedactedThinkingDisplay() {
  const [expanded, setExpanded] = useState(false);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="mt-2">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground transition-colors">
        <Brain className="h-3.5 w-3.5 shrink-0" />
        <span className="italic">Thinking (redacted)</span>
        <span className="ml-auto">{expanded ? '−' : '+'}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 border-l-2 border-muted pl-3 text-sm text-muted-foreground italic">
          Claude&apos;s thinking for this step was encrypted and is not shown.
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
