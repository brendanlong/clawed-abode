'use client';

import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import type { ToolCall } from './types';

interface ReadInput {
  file_path?: string;
  offset?: number;
  limit?: number;
}

interface ParsedLine {
  lineNumber: number;
  content: string;
}

/**
 * Parse Read tool output which has format like "     1→content" where:
 * - Line numbers are right-aligned with spaces
 * - Arrow separator (→) between line number and content
 * - Content may have leading whitespace that should be preserved
 */
function parseReadOutput(output: string): ParsedLine[] {
  if (!output || typeof output !== 'string') {
    return [];
  }

  const lines = output.split('\n');
  const result: ParsedLine[] = [];

  // Regex to match Claude's Read output format: spaces + number + → + content
  // The arrow character is → (U+2192)
  const linePattern = /^\s*(\d+)→(.*)$/;

  for (const line of lines) {
    // Skip system-reminder tags that may be injected
    if (line.includes('<system-reminder>') || line.includes('</system-reminder>')) {
      continue;
    }

    const match = line.match(linePattern);
    if (match) {
      result.push({
        lineNumber: parseInt(match[1], 10),
        content: match[2],
      });
    } else if (line.trim() && result.length === 0) {
      // If we haven't matched the pattern yet and there's content,
      // this might be raw file content without line numbers
      // In this case, just add lines with sequential numbers
      const rawLines = output
        .split('\n')
        .filter((l) => !l.includes('<system-reminder>') && !l.includes('</system-reminder>'));
      return rawLines.map((content, index) => ({
        lineNumber: index + 1,
        content,
      }));
    }
  }

  return result;
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
 * FileIcon component for Read tool display
 */
function FileIcon({ className }: { className?: string }) {
  return (
    <svg
      className={`w-4 h-4 text-muted-foreground flex-shrink-0 ${className ?? ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
      />
    </svg>
  );
}

/**
 * Specialized display for Read tool calls.
 * Shows file path and nicely formatted file content with line numbers.
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

  const parsedLines = useMemo(() => {
    if (typeof tool.output !== 'string') {
      return [];
    }
    return parseReadOutput(tool.output);
  }, [tool.output]);

  // Calculate the width needed for line numbers based on the highest line number
  const lineNumberWidth = useMemo(() => {
    if (parsedLines.length === 0) return 3;
    const maxLineNum = parsedLines[parsedLines.length - 1]?.lineNumber ?? 1;
    return Math.max(3, String(maxLineNum).length);
  }, [parsedLines]);

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
          {parsedLines.length} {parsedLines.length === 1 ? 'line' : 'lines'}
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
            <pre className="bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200 p-2 rounded overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap break-words">
              {typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}
            </pre>
          ) : parsedLines.length === 0 ? (
            <div className="text-muted-foreground italic py-2">(empty file)</div>
          ) : (
            <div className="bg-muted rounded overflow-hidden">
              <pre className="max-h-96 overflow-y-auto overflow-x-auto text-sm">
                <code className="block">
                  {parsedLines.map(({ lineNumber, content }) => (
                    <div key={lineNumber} className="flex hover:bg-background/50 leading-relaxed">
                      {/* Line number */}
                      <span
                        className="text-muted-foreground select-none pr-3 pl-2 text-right flex-shrink-0 border-r border-border/50"
                        style={{ minWidth: `${lineNumberWidth + 2}ch` }}
                      >
                        {lineNumber}
                      </span>
                      {/* Line content */}
                      <span className="pl-3 pr-2 whitespace-pre">{content}</span>
                    </div>
                  ))}
                </code>
              </pre>
            </div>
          )}
        </div>
      )}
    </ToolDisplayWrapper>
  );
}
