'use client';

import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { getFileType } from '@/lib/file-types';
import { FileIcon } from './FileIcon';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { ToolOutputBlock } from './ToolOutputBlock';
import { CodeBlock } from './CodeBlock';
import { parseReadOutput } from './read-output';
import type { ToolCall } from './types';

interface ReadInput {
  file_path?: string;
  offset?: number;
  limit?: number;
}

/**
 * Specialized display for Read tool calls.
 * Shows file path and syntax-highlighted file content (no line-number gutter).
 */
export function ReadDisplay({ tool }: { tool: ToolCall }) {
  const hasOutput = tool.output !== undefined;

  const input = tool.input as ReadInput | undefined;
  const filePath = input?.file_path ?? 'Unknown file';
  const offset = input?.offset;
  const limit = input?.limit;

  // Extract just the filename for the header
  const fileName = filePath.split('/').pop() ?? filePath;
  const fileType = useMemo(() => getFileType(filePath), [filePath]);

  const { code, lineCount } = useMemo(() => parseReadOutput(tool.output), [tool.output]);

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<FileIcon />}
      title="Read"
      pendingText="Reading..."
      headerContent={
        <span className="text-muted-foreground font-mono text-xs truncate">{fileName}</span>
      }
      subtitle={<div className="text-muted-foreground text-xs mt-1 truncate">{filePath}</div>}
      doneBadge={
        <Badge
          variant="outline"
          className="text-xs border-blue-500 text-blue-700 dark:text-blue-400"
        >
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </Badge>
      }
    >
      {/* Parameters section - only show if offset or limit are specified */}
      {(offset !== undefined || limit !== undefined) && (
        <div className="flex gap-4 text-muted-foreground">
          {offset !== undefined && (
            <span>
              Offset: <code className="bg-muted px-1.5 py-0.5 rounded">{offset}</code>
            </span>
          )}
          {limit !== undefined && (
            <span>
              Limit: <code className="bg-muted px-1.5 py-0.5 rounded">{limit}</code>
            </span>
          )}
        </div>
      )}

      {/* File type badge */}
      {hasOutput && !tool.is_error && fileType !== 'text' && (
        <div>
          <Badge variant="secondary" className="text-xs">
            {fileType}
          </Badge>
        </div>
      )}

      {/* File content section */}
      {hasOutput && (
        <div>
          {tool.is_error ? (
            <ToolOutputBlock output={tool.output} isError wrap />
          ) : code === '' ? (
            <div className="text-muted-foreground italic py-2">(empty file)</div>
          ) : (
            <CodeBlock code={code} fileType={fileType} />
          )}
        </div>
      )}
    </ToolDisplayWrapper>
  );
}
