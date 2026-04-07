import type { SubagentMessage } from './MessageListContext';

interface TaskOutputContent {
  type: 'text';
  text: string;
}

export interface TaskUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

/**
 * Parse the task output which comes as an array of content objects.
 * Returns the main text content, extracted agent ID, and usage stats if present.
 * The metadata block contains: agentId, and optionally <usage> with token/tool/duration info.
 */
export function parseTaskOutput(output: unknown): {
  text: string;
  agentId?: string;
  usage?: TaskUsage;
} {
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
    let usage: TaskUsage | undefined;

    for (const item of output) {
      if (typeof item === 'string') {
        textParts.push(item);
        const match = item.match(/agentId:\s*(\w+)/);
        if (match) agentId = match[1];
      } else if (item && typeof item === 'object') {
        const content = item as TaskOutputContent;
        if (content.type === 'text' && content.text) {
          const agentIdMatch = content.text.match(/agentId:\s*(\w+)/);
          if (agentIdMatch) {
            // This is the metadata block — extract agentId and usage stats
            agentId = agentIdMatch[1];
            const usageMatch = content.text.match(/<usage>([\s\S]*?)<\/usage>/);
            if (usageMatch) {
              const usageText = usageMatch[1];
              const tokens = usageText.match(/total_tokens:\s*(\d+)/)?.[1];
              const tools = usageText.match(/tool_uses:\s*(\d+)/)?.[1];
              const duration = usageText.match(/duration_ms:\s*(\d+)/)?.[1];
              usage = {
                totalTokens: tokens ? parseInt(tokens, 10) : undefined,
                toolUses: tools ? parseInt(tools, 10) : undefined,
                durationMs: duration ? parseInt(duration, 10) : undefined,
              };
            }
          } else {
            textParts.push(content.text);
          }
        }
      }
    }

    return {
      text: textParts.join('\n\n'),
      agentId,
      usage,
    };
  }

  return { text: '' };
}

export interface SubagentToolCall {
  id?: string;
  name: string;
  hasResult: boolean;
  isError: boolean;
}

/**
 * Extract a flat list of tool calls made by the subagent, paired with their results.
 */
export function extractSubagentToolCalls(messages: SubagentMessage[]): SubagentToolCall[] {
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
