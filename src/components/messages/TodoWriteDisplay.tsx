'use client';

import { Check, Circle, CircleCheck, RefreshCw } from 'lucide-react';
import { z } from 'zod';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ColorBadge } from './ColorBadge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { useMessageListTranscript } from './MessageListContext';
import { lenient, parseToolInput } from './tool-input';
import { todoItemSchema, type ToolCall } from './types';

const todoWriteInputSchema = z.object({ todos: lenient(z.array(todoItemSchema)) });

/**
 * Specialized display for TodoWrite tool calls.
 * Shows a checklist of todo items with status indicators.
 * Supports auto-collapse behavior for non-latest items.
 */
export function TodoWriteDisplay({ tool }: { tool: ToolCall }) {
  const ctx = useMessageListTranscript();
  const isLatest = ctx ? tool.id === ctx.latestTodoWriteId : false;
  // Follows isLatest (so older lists collapse as new ones arrive) until the user
  // toggles it.
  const [manual, setManual] = useState<boolean | null>(null);
  const expanded = manual ?? isLatest;

  const input = parseToolInput(tool.input, todoWriteInputSchema);
  const todos = input?.todos ?? [];

  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length;
  const totalCount = todos.length;

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<CircleCheck className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />}
      title="TodoWrite"
      expandedOverride={{ expanded, onOpenChange: setManual }}
      headerContent={
        <>
          <ColorBadge color={completedCount === totalCount ? 'green' : 'blue'}>
            {completedCount}/{totalCount} done
          </ColorBadge>
          {inProgressCount > 0 && <ColorBadge color="blue">{inProgressCount} active</ColorBadge>}
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
            {todo.status === 'completed' && (
              <Check className="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" />
            )}
            {todo.status === 'in_progress' && (
              <RefreshCw className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 animate-spin" />
            )}
            {todo.status === 'pending' && (
              <Circle className="w-4 h-4 text-muted-foreground shrink-0" />
            )}
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
