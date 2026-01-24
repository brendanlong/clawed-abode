'use client';

import { useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import { CopyButton } from './CopyButton';
import { formatAsJson } from './types';
import type { MessageContent } from './types';

interface HookStartedContent extends MessageContent {
  hook_id?: string;
  hook_name?: string;
  hook_event?: string;
}

/**
 * Display for hook_started messages showing a loading indicator while hook runs.
 */
export function HookStartedDisplay({ content }: { content: HookStartedContent }) {
  const getJsonText = useCallback(() => formatAsJson(content), [content]);

  // Extract a readable hook name (e.g., "SessionStart:resume" -> "Session Start (resume)")
  const formatHookName = (name?: string) => {
    if (!name) return 'Unknown Hook';
    // Split on colon for event:action format
    const [event, action] = name.split(':');
    // Add spaces before capitals (e.g., SessionStart -> Session Start)
    const formattedEvent = event.replace(/([a-z])([A-Z])/g, '$1 $2');
    return action ? `${formattedEvent} (${action})` : formattedEvent;
  };

  return (
    <div className="group">
      <div className="flex items-center gap-2 text-sm p-2">
        <Badge variant="secondary">
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          Hook
        </Badge>
        <span className="text-muted-foreground text-xs">
          {formatHookName(content.hook_name)} running...
        </span>
      </div>
      <div className="mt-1">
        <CopyButton getText={getJsonText} />
      </div>
    </div>
  );
}
