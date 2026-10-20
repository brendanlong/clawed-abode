'use client';

import { z } from 'zod';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { ColorBadge } from './ColorBadge';
import { getFileType } from '@/lib/syntax-highlight';
import { FileIcon } from './FileIcon';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { ToolOutputBlock } from './ToolOutputBlock';
import { CodeBlock } from './CodeBlock';
import { parseReadOutput } from '@/lib/read-output';
import { lenient, parseToolInput } from './tool-input';
import type { ToolCall } from './types';

const readInputSchema = z.object({
  file_path: lenient(z.string()),
  offset: lenient(z.number()),
  limit: lenient(z.number()),
});

/**
 * Specialized display for Read tool calls.
 * Shows file path and syntax-highlighted file content (no line-number gutter).
 */
export function ReadDisplay({ tool }: { tool: ToolCall }) {
  const input = parseToolInput(tool.input, readInputSchema);
  const filePath = input?.file_path ?? 'Unknown file';
  const offset = input?.offset;
  const limit = input?.limit;

  // Extract just the filename for the header
  const fileName = filePath.split('/').pop() ?? filePath;
  const fileType = useMemo(() => getFileType(filePath), [filePath]);

  const lineCount = tool.result?.summary.readLines ?? 0;

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
        <ColorBadge color="blue">
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </ColorBadge>
      }
    >
      {(output) => {
        const { code } = parseReadOutput(output.text);
        return (
          <>
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

            {output.text !== undefined && !output.isError && fileType !== 'text' && (
              <div>
                <Badge variant="secondary" className="text-xs">
                  {fileType}
                </Badge>
              </div>
            )}

            {output.text !== undefined && (
              <div>
                {output.isError ? (
                  <ToolOutputBlock output={output.text} isError wrap />
                ) : code === '' ? (
                  <div className="text-muted-foreground italic py-2">(empty file)</div>
                ) : (
                  <CodeBlock code={code} fileType={fileType} />
                )}
              </div>
            )}
          </>
        );
      }}
    </ToolDisplayWrapper>
  );
}
