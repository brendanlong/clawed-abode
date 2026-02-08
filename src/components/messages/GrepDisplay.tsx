'use client';

import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import type { ToolCall } from './types';

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  '-i'?: boolean;
  '-n'?: boolean;
  '-B'?: number;
  '-A'?: number;
  '-C'?: number;
  head_limit?: number;
  multiline?: boolean;
}

function SearchCodeIcon() {
  return (
    <svg
      className="w-4 h-4 text-purple-600 dark:text-purple-400 flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"
      />
    </svg>
  );
}

/**
 * Build a summary of grep options for display.
 */
function buildOptionsSummary(input: GrepInput): string {
  const parts: string[] = [];
  if (input['-i']) parts.push('case-insensitive');
  if (input.multiline) parts.push('multiline');
  if (input.glob) parts.push(`glob: ${input.glob}`);
  if (input.type) parts.push(`type: ${input.type}`);
  if (input.output_mode && input.output_mode !== 'files_with_matches')
    parts.push(input.output_mode);
  if (input.head_limit) parts.push(`limit: ${input.head_limit}`);
  return parts.join(', ');
}

/**
 * Parse grep output to count results.
 */
function countResults(output: string, outputMode?: string): number {
  if (!output) return 0;
  const lines = output.split('\n').filter((l) => l.trim().length > 0);
  if (outputMode === 'count') {
    // Count mode returns numbers
    return lines.reduce((sum, line) => {
      const num = parseInt(line.split(':').pop()?.trim() ?? '0', 10);
      return sum + (isNaN(num) ? 0 : num);
    }, 0);
  }
  return lines.length;
}

/**
 * Specialized display for Grep tool calls.
 * Shows the search pattern, options, and formatted results.
 */
export function GrepDisplay({ tool }: { tool: ToolCall }) {
  const hasOutput = tool.output !== undefined;

  const input = tool.input as GrepInput | undefined;
  const pattern = input?.pattern ?? '';
  const searchPath = input?.path;
  const outputMode = input?.output_mode ?? 'files_with_matches';

  const optionsSummary = useMemo(() => (input ? buildOptionsSummary(input) : ''), [input]);
  const resultCount = useMemo(() => {
    if (typeof tool.output !== 'string') return 0;
    return countResults(tool.output, outputMode);
  }, [tool.output, outputMode]);

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<SearchCodeIcon />}
      title="Grep"
      pendingText="Searching..."
      subtitle={
        <div className="text-muted-foreground text-xs mt-1 truncate font-mono">
          /{pattern}/{input?.['-i'] ? 'i' : ''}
          {searchPath && <span className="ml-2 text-muted-foreground">in {searchPath}</span>}
        </div>
      }
      doneBadge={
        <Badge
          variant="outline"
          className="text-xs border-purple-500 text-purple-700 dark:text-purple-400"
        >
          {resultCount} {resultCount === 1 ? 'match' : 'matches'}
        </Badge>
      }
    >
      {/* Pattern and options */}
      <div>
        <div className="text-muted-foreground mb-1">Pattern:</div>
        <code className="bg-muted px-2 py-1 rounded text-sm font-mono">{pattern}</code>
        {optionsSummary && (
          <div className="text-muted-foreground mt-1 text-xs">{optionsSummary}</div>
        )}
      </div>

      {/* Output section */}
      {hasOutput && (
        <div>
          <div className="text-muted-foreground mb-1">Results:</div>
          {tool.is_error ? (
            <pre className="bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200 p-2 rounded overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap break-words">
              {typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}
            </pre>
          ) : typeof tool.output === 'string' && tool.output.trim() ? (
            <pre className="bg-muted rounded p-2 max-h-96 overflow-y-auto overflow-x-auto text-sm font-mono whitespace-pre-wrap break-words">
              {tool.output}
            </pre>
          ) : (
            <div className="text-muted-foreground italic py-2">No matches found</div>
          )}
        </div>
      )}
    </ToolDisplayWrapper>
  );
}
