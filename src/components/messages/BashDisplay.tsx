'use client';

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

function TerminalIcon() {
  return (
    <svg
      className="w-4 h-4 text-green-600 dark:text-green-400 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z"
      />
    </svg>
  );
}

/**
 * Specialized display for Bash tool calls.
 * Shows the command, description, and formatted terminal output with ANSI support.
 */
export function BashDisplay({ tool }: { tool: ToolCall }) {
  const hasOutput = tool.output !== undefined;

  const input = parseToolInput(tool.input, bashInputSchema);
  const command = input?.command ?? '';
  const description = input?.description;
  const isBackground = input?.run_in_background ?? false;

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<TerminalIcon />}
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
      <div>
        <div className="text-muted-foreground mb-1">Command:</div>
        <pre className="bg-zinc-900 dark:bg-zinc-950 text-green-400 p-2 rounded overflow-x-auto whitespace-pre-wrap break-words text-sm font-mono">
          <span className="text-gray-500 select-none">$ </span>
          {command}
        </pre>
      </div>

      {hasOutput && (
        <ToolOutputBlock
          label="Output:"
          output={tool.output === '' ? '(no output)' : tool.output}
          isError={tool.is_error}
          wrap
          terminal
          preClassName="font-mono text-sm"
        />
      )}
    </ToolDisplayWrapper>
  );
}
