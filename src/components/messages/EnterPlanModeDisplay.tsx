'use client';

import { Lightbulb } from 'lucide-react';
import { ColorBadge } from './ColorBadge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import type { ToolCall } from './types';

/**
 * Specialized display for EnterPlanMode tool calls.
 * Shows a compact indicator that Claude has entered planning mode.
 */
export function EnterPlanModeDisplay({ tool }: { tool: ToolCall }) {
  const hasOutput = tool.result !== undefined;

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<Lightbulb className="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />}
      title="Entering Plan Mode"
      pendingText="Entering..."
      cardClassName="border-purple-300 dark:border-purple-700"
      subtitle={
        <div className="text-muted-foreground text-xs mt-1">
          Claude is exploring the codebase and designing an implementation approach
        </div>
      }
      doneBadge={hasOutput ? <ColorBadge color="purple">Planning</ColorBadge> : null}
    >
      <div className="text-muted-foreground text-xs py-1">
        Claude will explore the codebase and present a plan for your approval before making changes.
      </div>
    </ToolDisplayWrapper>
  );
}
