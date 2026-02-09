'use client';

import React from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import type { ContentBlock, ToolCall, ToolResultMap } from './types';
import { ToolCallDisplay } from './ToolCallDisplay';
import { GlobDisplay } from './GlobDisplay';
import { GrepDisplay } from './GrepDisplay';
import { EditDisplay } from './EditDisplay';
import { ReadDisplay } from './ReadDisplay';
import { WriteDisplay } from './WriteDisplay';
import { WebSearchDisplay } from './WebSearchDisplay';
import { WebFetchDisplay } from './WebFetchDisplay';
import { BashDisplay } from './BashDisplay';
import { NotebookEditDisplay } from './NotebookEditDisplay';
import { SkillDisplay } from './SkillDisplay';
import { TaskDisplay } from './TaskDisplay';
import { EnterPlanModeDisplay } from './EnterPlanModeDisplay';
import { ExitPlanModeDisplay } from './ExitPlanModeDisplay';
import { TodoWriteDisplay } from './TodoWriteDisplay';
import { AskUserQuestionDisplay } from './AskUserQuestionDisplay';

/**
 * Map of tool names to their specialized display components.
 * Tools not in this map fall through to the generic ToolCallDisplay.
 */
const TOOL_DISPLAY_MAP: Record<string, React.ComponentType<{ tool: ToolCall }>> = {
  Glob: GlobDisplay,
  Grep: GrepDisplay,
  Edit: EditDisplay,
  Read: ReadDisplay,
  Write: WriteDisplay,
  WebSearch: WebSearchDisplay,
  WebFetch: WebFetchDisplay,
  Bash: BashDisplay,
  NotebookEdit: NotebookEditDisplay,
  Skill: SkillDisplay,
  Task: TaskDisplay,
  EnterPlanMode: EnterPlanModeDisplay,
  ExitPlanMode: ExitPlanModeDisplay,
  TodoWrite: TodoWriteDisplay,
  AskUserQuestion: AskUserQuestionDisplay,
};

function renderContentBlocks(blocks: ContentBlock[], toolResults?: ToolResultMap): React.ReactNode {
  const textBlocks: string[] = [];
  const toolUseBlocks: ContentBlock[] = [];

  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      textBlocks.push(block.text);
    } else if (block.type === 'tool_use') {
      toolUseBlocks.push(block);
    }
  }

  return (
    <>
      {textBlocks.length > 0 && <MarkdownContent content={textBlocks.join('\n')} />}
      {toolUseBlocks.length > 0 && (
        <div className="mt-2 space-y-2">
          {toolUseBlocks.map((block) => {
            const result = block.id ? toolResults?.get(block.id) : undefined;
            const tool: ToolCall = {
              name: block.name || 'Unknown',
              id: block.id,
              input: block.input,
              output: result?.content,
              is_error: result?.is_error,
            };

            const DisplayComponent = TOOL_DISPLAY_MAP[block.name ?? ''];
            if (DisplayComponent) {
              return <DisplayComponent key={block.id} tool={tool} />;
            }

            return <ToolCallDisplay key={block.id} tool={tool} />;
          })}
        </div>
      )}
    </>
  );
}

/**
 * Renders message content - handles both string content and content block arrays.
 */
export function renderContent(content: unknown, toolResults?: ToolResultMap): React.ReactNode {
  if (typeof content === 'string') {
    return <MarkdownContent content={content} />;
  }

  if (Array.isArray(content)) {
    return renderContentBlocks(content as ContentBlock[], toolResults);
  }

  return null;
}
