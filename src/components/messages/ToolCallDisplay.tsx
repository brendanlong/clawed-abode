'use client';

import { z } from 'zod';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { ToolOutputBlock } from './ToolOutputBlock';
import { lenient, parseToolInput } from './tool-input';
import type { ToolCall } from './types';

const genericInputSchema = z.object({ description: lenient(z.string()) });

/**
 * Generic display for tool calls.
 * Shows tool name, optional description, and collapsible input/output.
 */
export function ToolCallDisplay({ tool }: { tool: ToolCall }) {
  const description = parseToolInput(tool.input, genericInputSchema)?.description;

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
      {(output) => (
        <>
          <div>
            <div className="text-muted-foreground mb-1">Input:</div>
            <pre className="bg-muted p-2 rounded overflow-x-auto">
              {JSON.stringify(tool.input, null, 2)}
            </pre>
          </div>
          {output.text !== undefined && (
            <ToolOutputBlock
              label="Output:"
              output={output.text}
              isError={output.isError}
              maxHeight="max-h-48"
              terminal
            />
          )}
        </>
      )}
    </ToolDisplayWrapper>
  );
}
