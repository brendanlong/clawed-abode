'use client';

import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { ToolOutputBlock } from './ToolOutputBlock';
import type { ToolCall } from './types';

/**
 * Generic display for tool calls.
 * Shows tool name, optional description, and collapsible input/output.
 */
export function ToolCallDisplay({ tool }: { tool: ToolCall }) {
  const hasOutput = tool.output !== undefined;

  // Extract description from input if present (e.g., Bash tool)
  const inputObj = tool.input as Record<string, unknown> | undefined;
  const description = inputObj?.description as string | undefined;

  return (
    <ToolDisplayWrapper
      tool={tool}
      title={tool.name}
      subtitle={
        description ? (
          <div className="text-muted-foreground text-xs mt-1 truncate">{description}</div>
        ) : undefined
      }
      doneBadge={null}
    >
      <div>
        <div className="text-muted-foreground mb-1">Input:</div>
        <pre className="bg-muted p-2 rounded overflow-x-auto">
          {JSON.stringify(tool.input, null, 2)}
        </pre>
      </div>
      {hasOutput && (
        <ToolOutputBlock
          label="Output:"
          output={tool.output}
          isError={tool.is_error}
          maxHeight="max-h-48"
          terminal
        />
      )}
    </ToolDisplayWrapper>
  );
}
