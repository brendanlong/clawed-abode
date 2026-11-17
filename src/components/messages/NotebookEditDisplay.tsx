'use client';

import { BookOpen } from 'lucide-react';
import { z } from 'zod';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ColorBadge } from './ColorBadge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { ToolOutputBlock } from './ToolOutputBlock';
import { lenient, parseToolInput } from './tool-input';
import type { ToolCall } from './types';

const notebookEditInputSchema = z.object({
  notebook_path: lenient(z.string()),
  cell_id: lenient(z.string()),
  new_source: lenient(z.string()),
  cell_type: lenient(z.enum(['code', 'markdown'])),
  edit_mode: lenient(z.enum(['replace', 'insert', 'delete'])),
});

/**
 * Specialized display for NotebookEdit tool calls.
 * Shows the notebook path, edit mode, cell info, and content.
 */
export function NotebookEditDisplay({ tool }: { tool: ToolCall }) {
  const input = parseToolInput(tool.input, notebookEditInputSchema);
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

  const editModeColor = ({ replace: 'blue', insert: 'green', delete: 'red' } as const)[editMode];

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<BookOpen className="w-4 h-4 text-orange-600 dark:text-orange-400 shrink-0" />}
      title="NotebookEdit"
      headerContent={
        <>
          <span className="text-muted-foreground font-mono text-xs truncate">{fileName}</span>
          <ColorBadge color={editModeColor}>{editModeLabel}</ColorBadge>
          <Badge variant="outline" className="text-xs">
            {cellType}
          </Badge>
        </>
      }
      subtitle={<div className="text-muted-foreground text-xs mt-1 truncate">{notebookPath}</div>}
      doneBadge={null}
    >
      {(output) => (
        <>
          {cellId && (
            <div>
              <span className="text-muted-foreground">Cell ID: </span>
              <code className="bg-muted px-1.5 py-0.5 rounded">{cellId}</code>
            </div>
          )}

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

          {output.text !== undefined && (
            <ToolOutputBlock
              label="Result:"
              output={output.text}
              isError={output.isError}
              maxHeight="max-h-32"
            />
          )}
        </>
      )}
    </ToolDisplayWrapper>
  );
}
