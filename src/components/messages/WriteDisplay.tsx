'use client';

import { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import type { ToolCall } from './types';

interface WriteInput {
  file_path?: string;
  content?: string;
}

/**
 * Detect file type from extension for syntax highlighting hints.
 */
function getFileType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const typeMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    xml: 'xml',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    dockerfile: 'docker',
    prisma: 'prisma',
  };
  return typeMap[ext] ?? 'text';
}

/**
 * FileIcon component for Write tool display
 */
function FileIcon({ className }: { className?: string }) {
  return (
    <svg
      className={cn('w-4 h-4 text-muted-foreground flex-shrink-0', className)}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
      />
    </svg>
  );
}

/**
 * Specialized display for Write tool calls.
 * Shows file path and the content being written to the file.
 */
export function WriteDisplay({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const hasOutput = tool.output !== undefined;
  const isPending = !hasOutput;

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
    <div className="group">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <Card
          className={cn(
            'mt-2',
            tool.is_error && 'border-red-300 dark:border-red-700',
            isPending && 'border-yellow-300 dark:border-yellow-700'
          )}
        >
          <CollapsibleTrigger className="w-full px-3 py-2 text-left flex items-center justify-between text-sm hover:bg-muted/50 rounded-t-xl">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <FileIcon />
                <span className="font-mono text-primary">Write</span>
                <span className="text-muted-foreground font-mono text-xs truncate">{fileName}</span>
                {isPending && (
                  <Badge
                    variant="outline"
                    className="text-xs border-yellow-500 text-yellow-700 dark:text-yellow-400"
                  >
                    Writing...
                  </Badge>
                )}
                {tool.is_error && (
                  <Badge variant="destructive" className="text-xs">
                    Error
                  </Badge>
                )}
                {hasOutput && !tool.is_error && (
                  <Badge
                    variant="outline"
                    className="text-xs border-green-500 text-green-700 dark:text-green-400"
                  >
                    {lineCount} {lineCount === 1 ? 'line' : 'lines'}
                  </Badge>
                )}
              </div>
              <div className="text-muted-foreground text-xs mt-1 truncate">{filePath}</div>
            </div>
            <span className="text-muted-foreground ml-2 flex-shrink-0">{expanded ? '−' : '+'}</span>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="p-3 space-y-3 text-xs">
              {/* File type badge */}
              {fileType !== 'text' && (
                <div>
                  <Badge variant="secondary" className="text-xs">
                    {fileType}
                  </Badge>
                </div>
              )}

              {/* File content section */}
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
                    {typeof tool.output === 'string'
                      ? tool.output
                      : JSON.stringify(tool.output, null, 2)}
                  </pre>
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
  );
}
