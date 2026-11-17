'use client';

import { SquareTerminal } from 'lucide-react';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { ToolOutputBlock } from './ToolOutputBlock';
import { lenient, parseToolInput } from './tool-input';
import type { ToolCall } from './types';

const bashInputSchema = z.object({
  command: lenient(z.string()),
  description: lenient(z.string()),
  run_in_background: lenient(z.boolean()),
});

/**
 * Specialized display for Bash tool calls.
 * Shows the command, description, and formatted terminal output with ANSI support.
 */
export function BashDisplay({ tool }: { tool: ToolCall }) {
  const input = parseToolInput(tool.input, bashInputSchema);
  const command = input?.command ?? '';
  const description = input?.description;
  const isBackground = input?.run_in_background ?? false;

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<SquareTerminal className="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" />}
      title="Bash"
      headerContent={
        isBackground ? (
          <Badge variant="outline" className="text-xs">
            background
          </Badge>
        ) : null
      }
      subtitle={
        description ? (
          <div className="text-muted-foreground text-xs mt-1 truncate">{description}</div>
        ) : undefined
      }
    >
      {(output) => (
        <>
          <div>
            <div className="text-muted-foreground mb-1">Command:</div>
            <pre className="bg-zinc-900 dark:bg-zinc-950 text-green-400 p-2 rounded overflow-x-auto whitespace-pre-wrap break-words text-sm font-mono">
              <span className="text-gray-500 select-none">$ </span>
              {command}
            </pre>
          </div>
          {output.text !== undefined && (
            <ToolOutputBlock
              label="Output:"
              output={output.text === '' ? '(no output)' : output.text}
              isError={output.isError}
              wrap
              terminal
              preClassName="font-mono text-sm"
            />
          )}
        </>
      )}
    </ToolDisplayWrapper>
  );
}
