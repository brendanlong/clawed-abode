'use client';

import { Sparkles } from 'lucide-react';
import { z } from 'zod';
import { ColorBadge } from './ColorBadge';
import { MarkdownContent } from '@/components/MarkdownContent';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { ToolOutputBlock } from './ToolOutputBlock';
import { lenient, parseToolInput } from './tool-input';
import type { ToolCall } from './types';

const skillInputSchema = z.object({ skill: lenient(z.string()), args: lenient(z.string()) });

/**
 * Specialized display for Skill tool calls.
 * Shows the skill name, arguments, and output.
 */
export function SkillDisplay({ tool }: { tool: ToolCall }) {
  const input = parseToolInput(tool.input, skillInputSchema);
  const skillName = input?.skill ?? 'Unknown';
  const args = input?.args;

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<Sparkles className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />}
      title="Skill"
      headerContent={<ColorBadge color="indigo">/{skillName}</ColorBadge>}
      subtitle={
        args ? (
          <div className="text-muted-foreground text-xs mt-1 truncate font-mono">{args}</div>
        ) : undefined
      }
    >
      {(output) => (
        <>
          {args && (
            <div>
              <div className="text-muted-foreground mb-1">Arguments:</div>
              <code className="bg-muted px-2 py-1 rounded text-sm">{args}</code>
            </div>
          )}

          {output.text !== undefined && (
            <div>
              <div className="text-muted-foreground mb-1">Output:</div>
              {output.isError ? (
                <ToolOutputBlock output={output.text} isError wrap />
              ) : (
                <div className="bg-muted rounded p-3 max-h-96 overflow-y-auto prose prose-sm dark:prose-invert max-w-none">
                  <MarkdownContent content={output.text ?? ''} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </ToolDisplayWrapper>
  );
}
