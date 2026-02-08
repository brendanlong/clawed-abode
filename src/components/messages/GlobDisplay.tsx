'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import type { ToolCall } from './types';

interface GlobInput {
  pattern: string;
  path?: string;
}

interface FileEntry {
  path: string;
  directory: string;
  filename: string;
}

/**
 * Parse glob output into structured file entries.
 * Groups files by directory for better organization.
 */
function parseGlobOutput(output: string): FileEntry[] {
  if (!output || typeof output !== 'string') {
    return [];
  }

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((path) => {
      const lastSlash = path.lastIndexOf('/');
      return {
        path,
        directory: lastSlash > 0 ? path.substring(0, lastSlash) : '',
        filename: lastSlash >= 0 ? path.substring(lastSlash + 1) : path,
      };
    });
}

/**
 * Group files by their directory.
 */
function groupByDirectory(files: FileEntry[]): Map<string, FileEntry[]> {
  const groups = new Map<string, FileEntry[]>();
  for (const file of files) {
    const existing = groups.get(file.directory) ?? [];
    existing.push(file);
    groups.set(file.directory, existing);
  }
  return groups;
}

// File icon component
const FileIcon = () => (
  <svg
    className="w-4 h-4 text-muted-foreground flex-shrink-0"
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

// Folder icon component
const FolderIcon = () => (
  <svg
    className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={1.5}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
    />
  </svg>
);

/**
 * Specialized display for Glob tool calls.
 * Shows a nicely formatted list of matched files organized by directory.
 */
export function GlobDisplay({ tool }: { tool: ToolCall }) {
  const hasOutput = tool.output !== undefined;

  const inputObj = tool.input as GlobInput | undefined;
  const pattern = inputObj?.pattern ?? '';
  const searchPath = inputObj?.path;

  const files = useMemo(() => {
    if (typeof tool.output !== 'string') {
      return [];
    }
    return parseGlobOutput(tool.output);
  }, [tool.output]);

  const groupedFiles = useMemo(() => groupByDirectory(files), [files]);

  return (
    <ToolDisplayWrapper
      tool={tool}
      title="Glob"
      subtitle={
        <div className="text-muted-foreground text-xs mt-1 truncate font-mono">{pattern}</div>
      }
      doneBadge={
        <Badge
          variant="outline"
          className="text-xs border-green-500 text-green-700 dark:text-green-400"
        >
          {files.length} {files.length === 1 ? 'file' : 'files'}
        </Badge>
      }
    >
      {/* Input section */}
      <div>
        <div className="text-muted-foreground mb-1">Pattern:</div>
        <code className="bg-muted px-2 py-1 rounded text-sm">{pattern}</code>
        {searchPath && (
          <span className="text-muted-foreground ml-2">
            in <code className="bg-muted px-1.5 py-0.5 rounded">{searchPath}</code>
          </span>
        )}
      </div>

      {/* Output section */}
      {hasOutput && (
        <div>
          <div className="text-muted-foreground mb-1">Matches:</div>
          {tool.is_error ? (
            <pre className="bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto">
              {typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}
            </pre>
          ) : files.length === 0 ? (
            <div className="text-muted-foreground italic py-2">No files matched</div>
          ) : (
            <div className="bg-muted rounded p-2 max-h-64 overflow-y-auto space-y-2">
              {Array.from(groupedFiles.entries()).map(([directory, dirFiles]) => (
                <div key={directory || '__root__'}>
                  {directory && (
                    <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
                      <FolderIcon />
                      <span className="font-mono text-xs">{directory}/</span>
                    </div>
                  )}
                  <ul className={cn('space-y-0.5', directory && 'ml-5')}>
                    {dirFiles.map((file) => (
                      <li
                        key={file.path}
                        className="flex items-center gap-1.5 py-0.5 hover:bg-background/50 rounded px-1 -mx-1"
                      >
                        <FileIcon />
                        <span className="font-mono text-foreground">{file.filename}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </ToolDisplayWrapper>
  );
}
