'use client';

import { useState } from 'react';
import { BellRing } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { parseTaskNotification } from '@/lib/claude-messages';
import { extractTextContent } from './messageHelpers';
import type { MessageContent } from './types';

/**
 * A background task (Monitor event, background command, subagent) reporting
 * back to the agent. Mostly noise to the user, so it's one quiet line with the
 * payload collapsed.
 */
export function TaskNotificationDisplay({ content }: { content: MessageContent }) {
  const [expanded, setExpanded] = useState(false);
  const notification = parseTaskNotification(content.origin, extractTextContent(content) ?? '');
  if (!notification) return null;
  const { summary, detail } = notification;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger
        disabled={!detail}
        className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground transition-colors disabled:hover:text-muted-foreground"
      >
        <BellRing className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{summary}</span>
        {detail && <span className="ml-auto">{expanded ? '−' : '+'}</span>}
      </CollapsibleTrigger>
      {detail && (
        <CollapsibleContent>
          <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words border-l-2 border-muted pl-3 text-xs text-muted-foreground">
            {detail}
          </pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
