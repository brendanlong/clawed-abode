'use client';

import { Badge } from '@/components/ui/badge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import type { ToolCall } from './types';

// Blueprint/planning icon
function PlanIcon() {
  return (
    <svg
      className="w-4 h-4 text-purple-600 dark:text-purple-400 flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18"
      />
    </svg>
  );
}

/**
 * Specialized display for EnterPlanMode tool calls.
 * Shows a compact indicator that Claude has entered planning mode.
 */
export function EnterPlanModeDisplay({ tool }: { tool: ToolCall }) {
  const hasOutput = tool.output !== undefined;

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<PlanIcon />}
      title="Entering Plan Mode"
      pendingText="Entering..."
      cardClassName="border-purple-300 dark:border-purple-700"
      subtitle={
        <div className="text-muted-foreground text-xs mt-1">
          Claude is exploring the codebase and designing an implementation approach
        </div>
      }
      doneBadge={
        hasOutput ? (
          <Badge
            variant="outline"
            className="text-xs border-purple-500 text-purple-700 dark:text-purple-400"
          >
            Planning
          </Badge>
        ) : null
      }
    >
      <div className="text-muted-foreground text-xs py-1">
        Claude will explore the codebase and present a plan for your approval before making changes.
      </div>
    </ToolDisplayWrapper>
  );
}
