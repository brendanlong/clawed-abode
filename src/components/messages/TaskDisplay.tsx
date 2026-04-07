'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { MarkdownContent } from '@/components/MarkdownContent';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { useMessageListContext, type SubagentMessage } from './MessageListContext';
import type { ToolCall } from './types';

interface TaskInput {
  subagent_type: string;
  description: string;
  prompt: string;
  model?: string;
  max_turns?: number;
  resume?: string;
  run_in_background?: boolean;
}

interface TaskOutputContent {
  type: 'text';
  text: string;
}

/**
 * Parse the task output which comes as an array of content objects.
 * Returns the main text content and extracted agent ID if present.
 */
function parseTaskOutput(output: unknown): { text: string; agentId?: string } {
  if (typeof output === 'string') {
    const agentIdMatch = output.match(/agentId:\s*(\w+)/);
    return {
      text: output,
      agentId: agentIdMatch?.[1],
    };
  }

  if (Array.isArray(output)) {
    const textParts: string[] = [];
    let agentId: string | undefined;

    for (const item of output) {
      if (typeof item === 'string') {
        textParts.push(item);
        const match = item.match(/agentId:\s*(\w+)/);
        if (match) agentId = match[1];
      } else if (item && typeof item === 'object') {
        const content = item as TaskOutputContent;
        if (content.type === 'text' && content.text) {
          // Check if this is the agentId line
          const agentIdMatch = content.text.match(/agentId:\s*(\w+)/);
          if (agentIdMatch) {
            agentId = agentIdMatch[1];
          } else {
            textParts.push(content.text);
          }
        }
      }
    }

    return {
      text: textParts.join('\n\n'),
      agentId,
    };
  }

  return { text: '' };
}

/**
 * Get a nice label for the subagent type.
 */
function getSubagentLabel(subagentType: string): { label: string; color: string } {
  switch (subagentType.toLowerCase()) {
    case 'explore':
      return { label: 'Explore', color: 'text-blue-700 dark:text-blue-400 border-blue-500' };
    case 'plan':
      return { label: 'Plan', color: 'text-purple-700 dark:text-purple-400 border-purple-500' };
    case 'bash':
      return { label: 'Bash', color: 'text-green-700 dark:text-green-400 border-green-500' };
    case 'general-purpose':
      return {
        label: 'General Purpose',
        color: 'text-orange-700 dark:text-orange-400 border-orange-500',
      };
    default:
      return { label: subagentType, color: 'text-gray-700 dark:text-gray-400 border-gray-500' };
  }
}

interface SubagentToolCall {
  id?: string;
  name: string;
  hasResult: boolean;
  isError: boolean;
}

/**
 * Extract a flat list of tool calls made by the subagent, paired with their results.
 */
function extractSubagentToolCalls(messages: SubagentMessage[]): SubagentToolCall[] {
  // First pass: collect all tool results by tool_use_id
  const results = new Map<string, { isError: boolean }>();
  for (const msg of messages) {
    if (msg.type !== 'user') continue;
    const content = msg.content as Record<string, unknown> | undefined;
    const msgBlocks = (content?.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(msgBlocks)) continue;
    for (const block of msgBlocks) {
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        results.set(b.tool_use_id, { isError: b.is_error === true });
      }
    }
  }

  // Second pass: collect tool_use blocks from assistant messages
  const toolCalls: SubagentToolCall[] = [];
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    const content = msg.content as Record<string, unknown> | undefined;
    const msgBlocks = (content?.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(msgBlocks)) continue;
    for (const block of msgBlocks) {
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_use') continue;
      const id = typeof b.id === 'string' ? b.id : undefined;
      const result = id ? results.get(id) : undefined;
      toolCalls.push({
        id,
        name: typeof b.name === 'string' ? b.name : 'Unknown',
        hasResult: result !== undefined,
        isError: result?.isError ?? false,
      });
    }
  }
  return toolCalls;
}

// Agent icon component - extracted outside of render
function AgentIcon() {
  return (
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
        d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
      />
    </svg>
  );
}

/**
 * Specialized display for Task tool calls.
 * Shows the subagent type, description, prompt, and formatted output.
 * Subagent messages are shown in a collapsible activity log.
 */
export function TaskDisplay({ tool }: { tool: ToolCall }) {
  const hasOutput = tool.output !== undefined;
  const [activityExpanded, setActivityExpanded] = useState(false);

  const inputObj = tool.input as TaskInput | undefined;
  const subagentType = inputObj?.subagent_type ?? 'Unknown';
  const description = inputObj?.description ?? '';
  const prompt = inputObj?.prompt ?? '';

  const { label: subagentLabel, color: subagentColor } = useMemo(
    () => getSubagentLabel(subagentType),
    [subagentType]
  );

  const { text: outputText, agentId } = useMemo(() => {
    if (!hasOutput) return { text: '' };
    return parseTaskOutput(tool.output);
  }, [tool.output, hasOutput]);

  const context = useMessageListContext();
  const subagentMessages = tool.id ? (context?.subagentMessagesByTaskId.get(tool.id) ?? []) : [];
  const subagentToolCalls = useMemo(
    () => extractSubagentToolCalls(subagentMessages),
    [subagentMessages]
  );

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<AgentIcon />}
      title="Task"
      headerContent={
        <Badge variant="outline" className={cn('text-xs', subagentColor)}>
          {subagentLabel}
        </Badge>
      }
      subtitle={
        description ? (
          <div className="text-muted-foreground text-xs mt-1 truncate">{description}</div>
        ) : undefined
      }
    >
      {/* Prompt section */}
      <div>
        <div className="text-muted-foreground mb-1">Prompt:</div>
        <pre className="bg-muted p-2 rounded overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap text-xs">
          {prompt}
        </pre>
      </div>

      {/* Subagent activity log */}
      {subagentToolCalls.length > 0 && (
        <Collapsible open={activityExpanded} onOpenChange={setActivityExpanded}>
          <CollapsibleTrigger className="w-full text-left flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground py-1">
            <span>{activityExpanded ? '−' : '+'}</span>
            <span>
              {subagentToolCalls.length} tool call{subagentToolCalls.length !== 1 ? 's' : ''}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-0.5 mt-1">
              {subagentToolCalls.map((tc, i) => (
                <div key={tc.id ?? i} className="flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full flex-shrink-0',
                      tc.isError
                        ? 'bg-red-500'
                        : tc.hasResult
                          ? 'bg-green-500'
                          : 'bg-yellow-400 animate-pulse'
                    )}
                  />
                  <span className="font-mono text-primary">{tc.name}</span>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Agent ID section */}
      {agentId && (
        <div>
          <div className="text-muted-foreground mb-1">Agent ID:</div>
          <code className="bg-muted px-2 py-1 rounded text-xs">{agentId}</code>
        </div>
      )}

      {/* Output section */}
      {hasOutput && (
        <div>
          <div className="text-muted-foreground mb-1">Output:</div>
          {tool.is_error ? (
            <pre className="bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200 p-2 rounded overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap">
              {outputText || JSON.stringify(tool.output, null, 2)}
            </pre>
          ) : outputText ? (
            <div className="bg-muted rounded p-3 max-h-96 overflow-y-auto prose prose-sm dark:prose-invert max-w-none">
              <MarkdownContent content={outputText} />
            </div>
          ) : (
            <div className="text-muted-foreground italic py-2">No output</div>
          )}
        </div>
      )}
    </ToolDisplayWrapper>
  );
}
