'use client';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { useMessageListContext } from './MessageListContext';
import { TaskDisplay, AgentIcon, getSubagentLabel, taskInputSchema } from './TaskDisplay';
import { parseToolInput } from './tool-input';
import type { ToolCall } from './types';

/**
 * Compact breadcrumb left at the spawn point when MessageList has relocated the
 * subagent's box, so the timeline keeps an anchor for when it kicked off.
 */
function SubagentStartedMarker({ tool }: { tool: ToolCall }) {
  const input = parseToolInput(tool.input, taskInputSchema);
  const { label, color } = getSubagentLabel(input?.subagent_type ?? 'Unknown');
  return (
    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
      <AgentIcon />
      <span className="shrink-0">Subagent started</span>
      <Badge variant="outline" className={cn('text-xs shrink-0', color)}>
        {label}
      </Badge>
      {input?.description && <span className="truncate">{input.description}</span>}
    </div>
  );
}

/**
 * Renders an `Agent`/`Task` tool call: the full {@link TaskDisplay} inline, or a
 * breadcrumb when MessageList is rendering the box somewhere else.
 */
export function SubagentToolDisplay({ tool }: { tool: ToolCall }) {
  const context = useMessageListContext();
  const relocated = tool.id ? context?.relocatedSubagentIds?.has(tool.id) : false;
  if (relocated) return <SubagentStartedMarker tool={tool} />;
  return <TaskDisplay tool={tool} />;
}
