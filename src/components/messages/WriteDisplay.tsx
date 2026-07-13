'use client';

import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { getFileType } from '@/lib/file-types';
import { FileIcon } from './FileIcon';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { ToolOutputBlock } from './ToolOutputBlock';
import { CodeBlock } from './CodeBlock';
import type { ToolCall } from './types';

interface WriteInput {
  file_path?: string;
  content?: string;
}

/**
 * Specialized display for Write tool calls.
 * Shows file path and the content being written to the file.
 *
 * Plan files render the same as any other file — the full plan is shown in the
 * ExitPlanMode approval panel, and seeing the raw Write here is useful for
 * tracking how the plan file changed.
 */
export function WriteDisplay({ tool }: { tool: ToolCall }) {
  const hasOutput = tool.output !== undefined;

  const input = tool.input as WriteInput | undefined;
  const filePath = input?.file_path ?? 'Unknown file';
  const content = input?.content ?? '';

  // Extract just the filename for the header
  const fileName = filePath.split('/').pop() ?? filePath;
  const fileType = useMemo(() => getFileType(filePath), [filePath]);

  // Count lines in content
  const lineCount = useMemo(() => {
    if (!content) return 0;
    return content.split('\n').length;
  }, [content]);

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<FileIcon variant="write" />}
      title="Write"
      pendingText="Writing..."
      headerContent={
        <span className="text-muted-foreground font-mono text-xs truncate">{fileName}</span>
      }
      subtitle={<div className="text-muted-foreground text-xs mt-1 truncate">{filePath}</div>}
      doneBadge={
        <Badge
          variant="outline"
          className="text-xs border-green-500 text-green-700 dark:text-green-400"
        >
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </Badge>
      }
    >
      {/* File type badge */}
      {fileType !== 'text' && (
        <div>
          <Badge variant="secondary" className="text-xs">
            {fileType}
          </Badge>
        </div>
      )}

      {/* File content */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-green-600 dark:text-green-400 font-medium">Content</span>
          <span className="text-muted-foreground">
            ({lineCount} {lineCount === 1 ? 'line' : 'lines'})
          </span>
        </div>
        {content ? (
          <CodeBlock code={content} fileType={fileType} />
        ) : (
          <div className="text-muted-foreground italic py-2">(empty file)</div>
        )}
      </div>

      {/* Output/Result if available */}
      {hasOutput && (
        <ToolOutputBlock
          label="Result:"
          output={tool.output}
          isError={tool.is_error}
          maxHeight="max-h-32"
        />
      )}
    </ToolDisplayWrapper>
  );
}
