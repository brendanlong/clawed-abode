'use client';

import React from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import type { ContentBlock, ToolCall, ToolResultMap } from './types';
import { buildToolCallFromBlock } from './messageHelpers';
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
import { SubagentToolDisplay } from './SubagentToolDisplay';
import { EnterPlanModeDisplay } from './EnterPlanModeDisplay';
import { ExitPlanModeDisplay } from './ExitPlanModeDisplay';
import { TodoWriteDisplay } from './TodoWriteDisplay';
import { AskUserQuestionDisplay } from './AskUserQuestionDisplay';
import { ThinkingDisplay } from './ThinkingDisplay';
import { ServerToolUseDisplay } from './ServerToolUseDisplay';

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
  // Subagent invocation. Current SDK spawns subagents via the `Agent` tool;
  // older sessions used `Task`. Both share the same input shape (subagent_type /
  // description / prompt). SubagentToolDisplay renders the full box inline, or a
  // compact "started" breadcrumb when MessageList has relocated the box (running
  // subagents pin to the bottom; finished-concurrent ones move to their finish
  // position). See computeSubagentPlacements.
  Agent: SubagentToolDisplay,
  Task: SubagentToolDisplay,
  EnterPlanMode: EnterPlanModeDisplay,
  ExitPlanMode: ExitPlanModeDisplay,
  TodoWrite: TodoWriteDisplay,
  AskUserQuestion: AskUserQuestionDisplay,
};

function renderContentBlocks(blocks: ContentBlock[], toolResults?: ToolResultMap): React.ReactNode {
  const thinkingParts: string[] = [];
  const textBlocks: string[] = [];
  const toolUseBlocks: ContentBlock[] = [];
  const serverToolUseBlocks: ContentBlock[] = [];
  let hasRedactedThinking = false;

  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      textBlocks.push(block.text);
    } else if (block.type === 'thinking' && block.thinking) {
      thinkingParts.push(block.thinking);
    } else if (block.type === 'redacted_thinking') {
      hasRedactedThinking = true;
    } else if (block.type === 'tool_use') {
      toolUseBlocks.push(block);
    } else if (block.type === 'server_tool_use') {
      serverToolUseBlocks.push(block);
    }
  }

  // Coalesce all visible thinking in this message into a single block. Redacted
  // thinking carries no text, so it is shown as its own separate indicator (a
  // message can contain both visible and redacted thinking blocks).
  const thinking = thinkingParts.join('\n\n');

  return (
    <>
      {thinking.length > 0 && <ThinkingDisplay thinking={thinking} />}
      {hasRedactedThinking && <ThinkingDisplay thinking="" redacted />}
      {textBlocks.length > 0 && <MarkdownContent content={textBlocks.join('\n')} />}
      {serverToolUseBlocks.length > 0 && (
        <div className="mt-2 space-y-1">
          {serverToolUseBlocks.map((block) => (
            <ServerToolUseDisplay key={block.id} name={block.name ?? 'unknown'} />
          ))}
        </div>
      )}
      {toolUseBlocks.length > 0 && (
        <div className="mt-2 space-y-2">
          {toolUseBlocks.map((block) => {
            const tool = buildToolCallFromBlock(block, toolResults);

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
