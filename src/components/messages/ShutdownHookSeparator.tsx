'use client';

import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface ShutdownHookSeparatorProps {
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Display for shutdown_hook_separator system messages.
 * Renders a dashed divider marking the start of shutdown hook output.
 * Acts as a toggle to expand/collapse all messages after it.
 */
export function ShutdownHookSeparator({ expanded, onToggle }: ShutdownHookSeparatorProps) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 text-sm p-2 hover:bg-muted/50 rounded transition-colors cursor-pointer"
    >
      <div className="flex-1 border-t border-dashed border-border" />
      {expanded ? (
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
      )}
      <Badge variant="secondary" className="flex-shrink-0">
        Shutdown Hook
      </Badge>
      {!expanded && (
        <span className="text-muted-foreground text-xs flex-shrink-0">click to expand</span>
      )}
      <div className="flex-1 border-t border-dashed border-border" />
    </button>
  );
}
