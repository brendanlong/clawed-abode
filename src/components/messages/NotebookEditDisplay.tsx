'use client';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import type { ToolCall } from './types';

interface NotebookEditInput {
  notebook_path: string;
  cell_id?: string;
  new_source: string;
  cell_type?: 'code' | 'markdown';
  edit_mode?: 'replace' | 'insert' | 'delete';
}

function NotebookIcon() {
  return (
    <svg
      className="w-4 h-4 text-orange-600 dark:text-orange-400 flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
      />
    </svg>
  );
}

/**
 * Specialized display for NotebookEdit tool calls.
 * Shows the notebook path, edit mode, cell info, and content.
 */
export function NotebookEditDisplay({ tool }: { tool: ToolCall }) {
  const hasOutput = tool.output !== undefined;

  const input = tool.input as NotebookEditInput | undefined;
  const notebookPath = input?.notebook_path ?? 'Unknown notebook';
  const cellId = input?.cell_id;
  const newSource = input?.new_source ?? '';
  const cellType = input?.cell_type ?? 'code';
  const editMode = input?.edit_mode ?? 'replace';

  const fileName = notebookPath.split('/').pop() ?? notebookPath;

  const editModeLabel = {
    replace: 'Replace',
    insert: 'Insert',
    delete: 'Delete',
  }[editMode];

  const editModeColor = {
    replace: 'border-blue-500 text-blue-700 dark:text-blue-400',
    insert: 'border-green-500 text-green-700 dark:text-green-400',
    delete: 'border-red-500 text-red-700 dark:text-red-400',
  }[editMode];

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<NotebookIcon />}
      title="NotebookEdit"
      headerContent={
        <>
          <span className="text-muted-foreground font-mono text-xs truncate">{fileName}</span>
          <Badge variant="outline" className={cn('text-xs', editModeColor)}>
            {editModeLabel}
          </Badge>
          <Badge variant="outline" className="text-xs">
            {cellType}
          </Badge>
        </>
      }
      subtitle={<div className="text-muted-foreground text-xs mt-1 truncate">{notebookPath}</div>}
      doneBadge={null}
    >
      {/* Cell info */}
      {cellId && (
        <div>
          <span className="text-muted-foreground">Cell ID: </span>
          <code className="bg-muted px-1.5 py-0.5 rounded">{cellId}</code>
        </div>
      )}

      {/* Content section */}
      {editMode !== 'delete' && newSource && (
        <div>
          <div className="text-muted-foreground mb-1">
            {editMode === 'insert' ? 'New cell content:' : 'Updated content:'}
          </div>
          <pre
            className={cn(
              'border p-2 rounded overflow-x-auto max-h-96 overflow-y-auto',
              editMode === 'insert'
                ? 'bg-green-50 dark:bg-green-950/50 border-green-200 dark:border-green-800'
                : 'bg-blue-50 dark:bg-blue-950/50 border-blue-200 dark:border-blue-800'
            )}
          >
            <code className="whitespace-pre-wrap break-words">{newSource}</code>
          </pre>
        </div>
      )}

      {/* Output/Result */}
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
