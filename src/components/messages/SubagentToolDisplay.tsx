'use client';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { useMessageListContext } from './MessageListContext';
import { TaskDisplay, AgentIcon, getSubagentLabel } from './TaskDisplay';
import type { ToolCall } from './types';

interface TaskInput {
  subagent_type?: string;
  description?: string;
}

/**
 * Compact "Subagent started" breadcrumb left at the spawn point when the full
 * Task box has been relocated (pinned at the bottom while running, or moved to
 * its finish position once done). Keeps the chronological anchor for *when* the
 * subagent kicked off without dragging its whole collapsed transcript up to the
 * top of the timeline. See {@link computeSubagentPlacements}.
 */
function SubagentStartedMarker({ tool }: { tool: ToolCall }) {
  const input = tool.input as TaskInput | undefined;
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
 * Renders an `Agent`/`Task` tool call. When MessageList has relocated this
 * subagent's box (running → pinned at bottom, or finished-with-interleaving →
 * moved to its finish position), the spawn-point render is a lightweight
 * breadcrumb; MessageList renders the full {@link TaskDisplay} in the relocated
 * spot. Otherwise (nested subagents, plain foreground waits, stopped/orphaned
 * subagents) it renders the full box inline here, unchanged.
 */
export function SubagentToolDisplay({ tool }: { tool: ToolCall }) {
  const context = useMessageListContext();
  const relocated = tool.id ? context?.relocatedSubagentIds?.has(tool.id) : false;
  if (relocated) return <SubagentStartedMarker tool={tool} />;
  return <TaskDisplay tool={tool} />;
}
