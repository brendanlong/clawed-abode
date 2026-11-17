'use client';

import { CodeXml } from 'lucide-react';
import { z } from 'zod';
import { useMemo } from 'react';
import { ColorBadge } from './ColorBadge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { ToolOutputBlock } from './ToolOutputBlock';
import { lenient, parseToolInput } from './tool-input';
import type { ToolCall } from './types';

const grepInputSchema = z.object({
  pattern: lenient(z.string()),
  path: lenient(z.string()),
  glob: lenient(z.string()),
  type: lenient(z.string()),
  output_mode: lenient(z.enum(['content', 'files_with_matches', 'count'])),
  '-i': lenient(z.boolean()),
  '-n': lenient(z.boolean()),
  '-B': lenient(z.number()),
  '-A': lenient(z.number()),
  '-C': lenient(z.number()),
  head_limit: lenient(z.number()),
  multiline: lenient(z.boolean()),
});
type GrepInput = z.infer<typeof grepInputSchema>;

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
 * Specialized display for Grep tool calls.
 * Shows the search pattern, options, and formatted results.
 */
export function GrepDisplay({ tool }: { tool: ToolCall }) {
  const input = parseToolInput(tool.input, grepInputSchema);
  const pattern = input?.pattern ?? '';
  const searchPath = input?.path;
  const outputMode = input?.output_mode ?? 'files_with_matches';

  const optionsSummary = useMemo(() => (input ? buildOptionsSummary(input) : ''), [input]);
  // Count mode prints `path:N` per file; the other modes print one match per line.
  const summary = tool.result?.summary;
  const resultCount = (outputMode === 'count' ? summary?.countTotal : summary?.nonBlankLines) ?? 0;

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<CodeXml className="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />}
      title="Grep"
      pendingText="Searching..."
      subtitle={
        <div className="text-muted-foreground text-xs mt-1 truncate font-mono">
          /{pattern}/{input?.['-i'] ? 'i' : ''}
          {searchPath && <span className="ml-2 text-muted-foreground">in {searchPath}</span>}
        </div>
      }
      doneBadge={
        <ColorBadge color="purple">
          {resultCount} {resultCount === 1 ? 'match' : 'matches'}
        </ColorBadge>
      }
    >
      {(output) => (
        <>
          <div>
            <div className="text-muted-foreground mb-1">Pattern:</div>
            <code className="bg-muted px-2 py-1 rounded text-sm font-mono">{pattern}</code>
            {optionsSummary && (
              <div className="text-muted-foreground mt-1 text-xs">{optionsSummary}</div>
            )}
          </div>

          {output.text !== undefined && (
            <div>
              <div className="text-muted-foreground mb-1">Results:</div>
              {output.isError || output.text?.trim() ? (
                <ToolOutputBlock
                  output={output.text}
                  isError={output.isError}
                  wrap
                  preClassName="text-sm font-mono"
                />
              ) : (
                <div className="text-muted-foreground italic py-2">No matches found</div>
              )}
            </div>
          )}
        </>
      )}
    </ToolDisplayWrapper>
  );
}
