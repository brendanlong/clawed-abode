'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { getFileType } from '@/lib/file-types';
import { MarkdownContent } from '@/components/MarkdownContent';
import { FileIcon } from './FileIcon';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { isPlanFile } from './plan-utils';
import type { ToolCall } from './types';

interface WriteInput {
  file_path?: string;
  content?: string;
}

/**
 * Specialized display for Write tool calls.
 * Shows file path and the content being written to the file.
 * For plan files (.md inside .claude/projects/), renders content as Markdown.
 */
export function WriteDisplay({ tool }: { tool: ToolCall }) {
  const hasOutput = tool.output !== undefined;

  const input = tool.input as WriteInput | undefined;
  const filePath = input?.file_path ?? 'Unknown file';
  const content = input?.content ?? '';

  // Extract just the filename for the header
  const fileName = filePath.split('/').pop() ?? filePath;
  const fileType = useMemo(() => getFileType(filePath), [filePath]);

  // Check if this is a plan file
  const isPlan = useMemo(() => isPlanFile(filePath), [filePath]);

  // Count lines in content
  const lineCount = useMemo(() => {
    if (!content) return 0;
    return content.split('\n').length;
  }, [content]);

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<FileIcon variant="write" />}
      title={isPlan ? 'Plan' : 'Write'}
      pendingText={isPlan ? 'Writing plan...' : 'Writing...'}
      headerContent={
        !isPlan ? (
          <span className="text-muted-foreground font-mono text-xs truncate">{fileName}</span>
        ) : undefined
      }
      subtitle={
        isPlan ? (
          <div className="text-muted-foreground text-xs mt-1">
            Claude is writing a plan for your review
          </div>
        ) : (
          <div className="text-muted-foreground text-xs mt-1 truncate">{filePath}</div>
        )
      }
      doneBadge={
        isPlan ? (
          <Badge
            variant="outline"
            className="text-xs border-purple-500 text-purple-700 dark:text-purple-400"
          >
            Plan
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="text-xs border-green-500 text-green-700 dark:text-green-400"
          >
            {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          </Badge>
        )
      }
      cardClassName={isPlan ? 'border-purple-300 dark:border-purple-700' : undefined}
      defaultExpanded={isPlan}
    >
      {/* File type badge (non-plan files only) */}
      {!isPlan && fileType !== 'text' && (
        <div>
          <Badge variant="secondary" className="text-xs">
            {fileType}
          </Badge>
        </div>
      )}

      {/* Plan file: render as Markdown */}
      {isPlan && content && (
        <div className="bg-muted/50 rounded p-3 overflow-y-auto max-h-[600px]">
          <MarkdownContent content={content} />
        </div>
      )}

      {/* Non-plan file: show raw content */}
      {!isPlan && (
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-green-600 dark:text-green-400 font-medium">Content</span>
            <span className="text-muted-foreground">
              ({lineCount} {lineCount === 1 ? 'line' : 'lines'})
            </span>
          </div>
          {content ? (
            <pre className="bg-green-50 dark:bg-green-950/50 border border-green-200 dark:border-green-800 p-2 rounded overflow-x-auto max-h-96 overflow-y-auto">
              <code className="text-green-800 dark:text-green-200 whitespace-pre-wrap break-words">
                {content}
              </code>
            </pre>
          ) : (
            <div className="text-muted-foreground italic py-2">(empty file)</div>
          )}
        </div>
      )}

      {/* Output/Result if available (non-plan files only) */}
      {!isPlan && hasOutput && (
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
