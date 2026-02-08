'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import type { ToolCall, TodoItem } from './types';

interface TodoWriteInput {
  todos: TodoItem[];
}

interface TodoWriteDisplayProps {
  tool: ToolCall;
  isLatest?: boolean;
  wasManuallyToggled?: boolean;
  onManualToggle?: () => void;
}

// Checkmark icon for completed items
function CheckIcon() {
  return (
    <svg
      className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}

// Spinner icon for in-progress items
function SpinnerIcon() {
  return (
    <svg
      className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0 animate-spin"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M2.985 19.644l3.182-3.182"
      />
    </svg>
  );
}

// Empty circle icon for pending items
function CircleIcon() {
  return (
    <svg
      className="w-4 h-4 text-muted-foreground flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

// Clipboard/checklist icon
function ChecklistIcon() {
  return (
    <svg
      className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

/**
 * Specialized display for TodoWrite tool calls.
 * Shows a checklist of todo items with status indicators.
 * Supports auto-collapse behavior for non-latest items.
 */
export function TodoWriteDisplay({
  tool,
  isLatest = false,
  wasManuallyToggled = false,
  onManualToggle,
}: TodoWriteDisplayProps) {
  const [manualExpandedState, setManualExpandedState] = useState(true);

  // Conditional expanded state:
  // - If user hasn't toggled: follow isLatest
  // - If user has toggled: use local state
  const expanded = wasManuallyToggled ? manualExpandedState : isLatest;

  const handleOpenChange = (open: boolean) => {
    onManualToggle?.();
    setManualExpandedState(open);
  };

  const input = tool.input as TodoWriteInput | undefined;
  const todos = input?.todos ?? [];

  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length;
  const totalCount = todos.length;

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<ChecklistIcon />}
      title="TodoWrite"
      expandedOverride={{ expanded, onOpenChange: handleOpenChange }}
      headerContent={
        <>
          <Badge
            variant="outline"
            className={cn(
              'text-xs',
              completedCount === totalCount
                ? 'border-green-500 text-green-700 dark:text-green-400'
                : 'border-blue-500 text-blue-700 dark:text-blue-400'
            )}
          >
            {completedCount}/{totalCount} done
          </Badge>
          {inProgressCount > 0 && (
            <Badge
              variant="outline"
              className="text-xs border-blue-500 text-blue-700 dark:text-blue-400"
            >
              {inProgressCount} active
            </Badge>
          )}
        </>
      }
      isPendingOverride={false}
      doneBadge={null}
    >
      {/* Todo list */}
      <ul className="space-y-1.5">
        {todos.map((todo, index) => (
          <li
            key={index}
            className={cn(
              'flex items-start gap-2 py-1 px-2 rounded text-sm',
              todo.status === 'completed' && 'text-muted-foreground',
              todo.status === 'in_progress' && 'bg-blue-50 dark:bg-blue-950/30'
            )}
          >
            {todo.status === 'completed' && <CheckIcon />}
            {todo.status === 'in_progress' && <SpinnerIcon />}
            {todo.status === 'pending' && <CircleIcon />}
            <span
              className={cn(
                todo.status === 'completed' && 'line-through',
                todo.status === 'in_progress' && 'font-medium'
              )}
            >
              {todo.status === 'in_progress' ? todo.activeForm : todo.content}
            </span>
          </li>
        ))}
      </ul>
    </ToolDisplayWrapper>
  );
}
