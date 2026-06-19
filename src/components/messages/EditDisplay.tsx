'use client';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { InlineDiff } from './InlineDiff';
import type { ToolCall } from './types';

interface EditInput {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
}

/**
 * Specialized display for Edit tool calls.
 * Shows file path and a diff-like view of old vs new content.
 *
 * Plan files render the same as any other file — the full plan is shown in the
 * ExitPlanMode approval panel, so seeing the diff here is useful for tracking
 * how the plan changed.
 */
export function EditDisplay({ tool }: { tool: ToolCall }) {
  const hasOutput = tool.output !== undefined;

  const input = tool.input as EditInput | undefined;
  const filePath = input?.file_path ?? 'Unknown file';
  const oldString = input?.old_string ?? '';
  const newString = input?.new_string ?? '';
  const replaceAll = input?.replace_all ?? false;

  // Extract just the filename for the header
  const fileName = filePath.split('/').pop() ?? filePath;

  return (
    <ToolDisplayWrapper
      tool={tool}
      title="Edit"
      headerContent={
        <>
          <span className="text-muted-foreground font-mono text-xs truncate">{fileName}</span>
          {replaceAll && (
            <Badge variant="outline" className="text-xs">
              replace all
            </Badge>
          )}
        </>
      }
      subtitle={<div className="text-muted-foreground text-xs mt-1 truncate">{filePath}</div>}
      doneBadge={null}
    >
      {/* Inline diff of old vs new content */}
      <InlineDiff oldString={oldString} newString={newString} />

      {/* Output/Result if available */}
      {hasOutput && (
        <div>
          <div className="text-muted-foreground mb-1">Result:</div>
          <pre
            className={cn(
              'p-2 rounded overflow-x-auto max-h-32 overflow-y-auto',
              tool.is_error
                ? 'bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200'
                : 'bg-muted'
            )}
          >
            {typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}
          </pre>
        </div>
      )}
    </ToolDisplayWrapper>
  );
}
