import type {
  ContentBlock,
  DisplayMessage,
  MessageContent,
  ToolCall,
  ToolResultMap,
} from './types';
import { formatAsJson, buildToolMessages } from './types';

/**
 * Strip XML wrapper tags from Claude Code local command output.
 * Messages from slash commands like /context are wrapped in tags like
 * <local-command-stdout>...</local-command-stdout>.
 */
function stripXmlTags(text: string): string {
  return text.replace(/^<local-command-stdout>\n?/, '').replace(/\n?<\/local-command-stdout>$/, '');
}

export type MessageCategory =
  | 'assistant'
  | 'user'
  | 'userInterrupt'
  | 'toolResult'
  | 'systemError'
  | 'systemCompactBoundary'
  | 'systemRefusalFallback'
  | 'result';

export type RecognitionResult =
  | { recognized: true; category: MessageCategory }
  | { recognized: false };

/**
 * Extract text content from message content blocks.
 * For user/assistant messages, returns the raw markdown text.
 */
export function extractTextContent(content: MessageContent): string | null {
  // For assistant messages, extract text from content.message.content
  if (content.message?.content && Array.isArray(content.message.content)) {
    const textBlocks = content.message.content
      .filter(
        (block): block is ContentBlock => block.type === 'text' && typeof block.text === 'string'
      )
      .map((block) => block.text!);
    if (textBlocks.length > 0) {
      return textBlocks.join('\n');
    }
  }
  // For messages with string content in message.content (e.g., /context command output)
  if (typeof content.message?.content === 'string') {
    return stripXmlTags(content.message.content);
  }
  // For simple content strings
  if (typeof content.content === 'string') {
    return content.content;
  }
  return null;
}

/**
 * Check if a message is a tool result (comes as type "user" but contains tool_result content).
 */
export function isToolResultMessage(content: MessageContent): boolean {
  const innerContent = content.message?.content;
  if (Array.isArray(innerContent)) {
    return innerContent.some((block) => block.type === 'tool_result');
  }
  return false;
}

/**
 * Extract tool result blocks from a message.
 */
export function getToolResults(content: MessageContent): ContentBlock[] {
  const innerContent = content.message?.content;
  if (Array.isArray(innerContent)) {
    return innerContent.filter((block) => block.type === 'tool_result');
  }
  return [];
}

/**
 * Whether an assistant message has any content worth rendering. Filters out
 * fragments whose blocks would all render to nothing — e.g. a `thinking` block
 * with empty `thinking` text (just a continuity signature) and nothing else,
 * which would otherwise show as an empty assistant bubble.
 *
 * Keep the renderable cases in sync with `ContentRenderer.renderContentBlocks`.
 */
export function hasRenderableAssistantContent(content: MessageContent): boolean {
  const blocks = content?.message?.content;
  // Non-array content (e.g. a string) is handled by other display paths.
  if (!Array.isArray(blocks)) return true;
  return blocks.some((block) => {
    switch (block?.type) {
      case 'text':
        return typeof block.text === 'string' && block.text.trim().length > 0;
      case 'thinking':
        return typeof block.thinking === 'string' && block.thinking.trim().length > 0;
      case 'tool_use':
      case 'redacted_thinking':
      case 'server_tool_use':
        return true;
      // advisor_tool_result is deliberately not renderable: its content is
      // encrypted, so the server_tool_use block is the visible indicator.
      default:
        return false;
    }
  });
}

/**
 * System subtypes still surfaced in the transcript. Everything else — session
 * init banners, hook lifecycle, task/notification chatter, generic notices — is
 * hidden to cut noise (issue #312). Errors, compact boundaries, and
 * model_refusal_fallback (a silent Fable→Opus downgrade the user needs to know
 * about) are kept because they carry meaningful signal the user needs to see.
 */
const VISIBLE_SYSTEM_SUBTYPES = new Set(['error', 'compact_boundary', 'model_refusal_fallback']);

/**
 * Whether a `system` message should be hidden from the transcript entirely.
 * Non-system messages are never hidden by this. Pure so it can gate both the
 * list-level filter (no empty spacer row) and the bubble-level render.
 */
export function isHiddenSystemMessage(type: string, content: MessageContent): boolean {
  if (type !== 'system') return false;
  return !(typeof content.subtype === 'string' && VISIBLE_SYSTEM_SUBTYPES.has(content.subtype));
}

/**
 * Whether an assistant message is purely one or more tool calls, with no other
 * visible content. Consecutive such messages are the "back-to-back tool calls"
 * that should render tightly packed rather than with full inter-message spacing.
 *
 * Any block that renders its own visible element above the tool calls — non-empty
 * text or thinking, a redacted-thinking indicator, or a server_tool_use (advisor)
 * indicator — disqualifies the message. Keep in sync with
 * {@link hasRenderableAssistantContent}.
 */
export function isToolCallOnlyMessage(content: MessageContent): boolean {
  const blocks = content?.message?.content;
  if (!Array.isArray(blocks)) return false;
  let hasToolUse = false;
  for (const block of blocks) {
    switch (block.type) {
      case 'tool_use':
        hasToolUse = true;
        break;
      case 'text':
        if (typeof block.text === 'string' && block.text.trim()) return false;
        break;
      case 'thinking':
        if (typeof block.thinking === 'string' && block.thinking.trim()) return false;
        break;
      case 'redacted_thinking':
      case 'server_tool_use':
        return false;
    }
  }
  return hasToolUse;
}

/**
 * The tool_use id of the Task that spawned this message, or null for a top-level
 * (main-agent) message. Subagent messages carry `parent_tool_use_id`.
 */
export function getParentToolUseId(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const parent = (content as Record<string, unknown>).parent_tool_use_id;
  return typeof parent === 'string' ? parent : null;
}

/**
 * The lifecycle of a single top-level subagent (`Agent`/`Task` call), derived
 * from the message stream. Distinguishes **background/async** subagents (spawned
 * with a `task_started`, which return an immediate "launched" ack `tool_result`
 * and keep working — their real completion is a later `task_notification`) from
 * plain **foreground** ones (whose `tool_result` IS their finish). Keying finish
 * off the `tool_result` alone would misplace background subagents at their early
 * ack — exactly the concurrent case worth relocating.
 */
export interface SubagentLifecycle {
  toolUseId: string;
  /** Sequence of the main-agent message that spawned it. */
  spawnSequence: number;
  /** Launched as a background/async task (a persisted `task_started` exists). */
  isBackground: boolean;
  /** Sequence of its terminal `task_notification`, or null if none persisted. */
  notificationSequence: number | null;
  /** Highest sequence among its child (`parent_tool_use_id`) messages, or null. */
  lastChildSequence: number | null;
  /**
   * Sequence of its `tool_result` — the async-launch ack for a background
   * subagent, or the real result for a foreground one — or null if unresolved.
   */
  resultSequence: number | null;
}

/**
 * Where each top-level subagent's box should render. A background/concurrent
 * subagent's box is disruptive at its spawn point: its transcript collapses at
 * the top while the main agent's concurrent messages stream out below it, so the
 * main-agent work reads as if it escaped the box. So:
 *
 * - **running** (not settled, session live): compact breadcrumb at the spawn
 *   point, live box pinned at the bottom of the panel.
 * - **finished, with main-agent rows interleaved** between spawn and finish:
 *   breadcrumb at spawn, full box relocated to the finish position — where it
 *   chronologically belongs.
 * - **finished with nothing interleaved** (a plain foreground wait) or **not
 *   settled while the session is not live** (stopped / query died): not relocated
 *   — the box renders inline at the spawn point, exactly as before.
 */
export interface SubagentPlacements {
  /** Tool_use ids whose spawn-point render should be a breadcrumb (box moved). */
  relocatedIds: Set<string>;
  /** Finished subagents, rendered as a full box at `atSequence`, sorted. */
  finished: { toolUseId: string; atSequence: number }[];
  /** Running subagents, pinned at the bottom in spawn order. */
  running: string[];
}

/**
 * Resolve a subagent's finish sequence (where its box should settle) and whether
 * it is still running, from its {@link SubagentLifecycle}.
 *
 * - A terminal `task_notification` is the authoritative finish.
 * - A background subagent without one is still running while the session is live;
 *   once the session is idle it has settled — its last child message (or its
 *   launch ack) is the best available finish position.
 * - A foreground subagent **never pins**: it blocks the main agent, so there is no
 *   concurrent traffic to escape past. It finishes at its `tool_result`; before
 *   that (or if the query died before one) it stays inline at its spawn point.
 */
function resolveSubagentFinish(
  life: SubagentLifecycle,
  isSessionRunning: boolean
): { kind: 'running' } | { kind: 'finished'; atSequence: number } | { kind: 'inline' } {
  if (life.notificationSequence !== null) {
    return { kind: 'finished', atSequence: life.notificationSequence };
  }
  if (life.isBackground) {
    if (isSessionRunning) return { kind: 'running' };
    const settled = life.lastChildSequence ?? life.resultSequence;
    return settled !== null && settled !== undefined
      ? { kind: 'finished', atSequence: settled }
      : { kind: 'inline' };
  }
  // Foreground: inline at spawn until its tool_result settles it. Never pinned —
  // a synchronous subagent runs with no concurrent main-agent messages, so
  // relocating it would only add a redundant breadcrumb + bottom box.
  return life.resultSequence !== null
    ? { kind: 'finished', atSequence: life.resultSequence }
    : { kind: 'inline' };
}

/**
 * Pure placement decision for top-level subagent boxes. See {@link SubagentPlacements}.
 *
 * @param lifecycles Top-level subagent lifecycles, in spawn order.
 * @param topLevelRowSequences Sequences of the top-level rows that actually render,
 *   used to detect whether anything interleaved between a subagent's spawn and finish.
 * @param isSessionRunning Whether the session's query is live (gates pinning so a
 *   subagent orphaned by a dead query isn't pinned forever).
 */
export function computeSubagentPlacements(
  lifecycles: SubagentLifecycle[],
  topLevelRowSequences: number[],
  isSessionRunning: boolean
): SubagentPlacements {
  const relocatedIds = new Set<string>();
  const finished: { toolUseId: string; atSequence: number }[] = [];
  const running: string[] = [];

  for (const life of lifecycles) {
    const outcome = resolveSubagentFinish(life, isSessionRunning);

    if (outcome.kind === 'running') {
      relocatedIds.add(life.toolUseId);
      running.push(life.toolUseId);
      continue;
    }
    if (outcome.kind === 'inline') continue;

    // Finished: relocate to the finish position only if main-agent rows landed
    // between spawn and finish; otherwise (a plain foreground wait) stay inline.
    const interleaved = topLevelRowSequences.some(
      (seq) => seq > life.spawnSequence && seq < outcome.atSequence
    );
    if (interleaved) {
      relocatedIds.add(life.toolUseId);
      finished.push({ toolUseId: life.toolUseId, atSequence: outcome.atSequence });
    }
  }

  finished.sort((a, b) => a.atSequence - b.atSequence);
  return { relocatedIds, finished, running };
}

/**
 * Group subagent messages by the tool_use id of the Task that spawned them.
 * Messages without a `parent_tool_use_id` (main-agent messages) are omitted.
 * Preserves input order within each group.
 */
export function groupSubagentMessages(messages: DisplayMessage[]): Map<string, DisplayMessage[]> {
  const groups = new Map<string, DisplayMessage[]>();
  for (const message of messages) {
    const parent = getParentToolUseId(message.content);
    if (!parent) continue;
    const existing = groups.get(parent);
    if (existing) {
      existing.push(message);
    } else {
      groups.set(parent, [message]);
    }
  }
  return groups;
}

/**
 * Whether a message should render as its own row in a transcript (top-level list
 * or a nested subagent transcript). Shared by both so the two can't drift.
 *
 * Excludes: tool-result messages already paired inline onto their tool call,
 * hidden system messages (see {@link isHiddenSystemMessage} — which subsumes the
 * ignored-subtype set, and skip_transcript messages are never persisted), and
 * empty assistant fragments. Does NOT apply the top-level "no subagent messages"
 * rule — callers add that separately, since a subagent transcript renders exactly
 * those messages.
 */
export function isVisibleTranscriptMessage(
  message: DisplayMessage,
  pairedMessageIds: Set<string>
): boolean {
  if (pairedMessageIds.has(message.id)) return false;
  const content = message.content as MessageContent;
  if (isHiddenSystemMessage(message.type, content)) return false;
  if (message.type === 'assistant' && !hasRenderableAssistantContent(content)) return false;
  return true;
}

/**
 * Check if a message can be recognized and displayed with our typed components.
 * Returns the message category if recognized, or { recognized: false } for unknown types.
 */
export function isRecognizedMessage(type: string, content: MessageContent): RecognitionResult {
  // Assistant messages must have a valid message.content array
  if (type === 'assistant') {
    if (!content.message || !Array.isArray(content.message.content)) {
      return { recognized: false };
    }
    return { recognized: true, category: 'assistant' };
  }

  // User messages that are tool results
  if (type === 'user' && isToolResultMessage(content)) {
    return { recognized: true, category: 'toolResult' };
  }

  // User interrupt messages
  if (type === 'user' && content.subtype === 'interrupt') {
    return { recognized: true, category: 'userInterrupt' };
  }

  // Regular user messages (prompts) must have text content
  if (type === 'user') {
    // User prompts typically have message.content with text blocks
    if (content.message?.content && Array.isArray(content.message.content)) {
      return { recognized: true, category: 'user' };
    }
    // Or message.content as a string (e.g., /context command output)
    if (typeof content.message?.content === 'string') {
      return { recognized: true, category: 'user' };
    }
    // Or simple content string
    if (typeof content.content === 'string') {
      return { recognized: true, category: 'user' };
    }
    return { recognized: false };
  }

  // The only system messages shown in the transcript are errors, compact
  // boundaries, and refusal fallbacks (see isHiddenSystemMessage). Every other
  // system subtype — init, hooks, generic notices — is hidden upstream in
  // MessageBubble/MessageList, so it is intentionally not given a category here.
  if (type === 'system' && content.subtype === 'error') {
    if (Array.isArray(content.content)) {
      return { recognized: true, category: 'systemError' };
    }
    return { recognized: false };
  }

  // Compact boundary messages
  if (type === 'system' && content.subtype === 'compact_boundary') {
    return { recognized: true, category: 'systemCompactBoundary' };
  }

  // Fable→Opus refusal fallback: a silent model downgrade the user needs to see.
  if (type === 'system' && content.subtype === 'model_refusal_fallback') {
    return { recognized: true, category: 'systemRefusalFallback' };
  }

  // Result messages
  if (type === 'result') {
    if (content.subtype && typeof content.session_id === 'string') {
      return { recognized: true, category: 'result' };
    }
    return { recognized: false };
  }

  // Unknown type
  return { recognized: false };
}

/**
 * Build the ToolCall view-model for a single `tool_use` block, pairing it with
 * its result from the result map. The one place the (block + result) → ToolCall
 * shape is defined — shared by {@link buildToolCalls}, `ContentRenderer` (inline
 * tool rendering), and `MessageList` (reconstructing a relocated subagent box
 * from its call block) so the shape and defaults can't drift.
 */
export function buildToolCallFromBlock(block: ContentBlock, toolResults?: ToolResultMap): ToolCall {
  const result = block.id ? toolResults?.get(block.id) : undefined;
  return {
    name: block.name || 'Unknown',
    id: block.id,
    input: block.input,
    output: result?.content,
    is_error: result?.is_error,
  };
}

/**
 * Build tool call objects with results for assistant messages.
 */
export function buildToolCalls(content: MessageContent, toolResults?: ToolResultMap): ToolCall[] {
  const messageContent = content.message?.content;
  if (!Array.isArray(messageContent)) return [];

  return messageContent
    .filter((block): block is ContentBlock => block.type === 'tool_use')
    .map((block) => buildToolCallFromBlock(block, toolResults));
}

/**
 * Get the text to copy for a message.
 */
export function getCopyText(
  content: MessageContent,
  category: MessageCategory | null,
  toolCalls: ToolCall[]
): string {
  if (category === 'user') {
    const text = extractTextContent(content);
    return text ?? formatAsJson(content);
  }
  if (category === 'assistant') {
    const text = extractTextContent(content);
    if (toolCalls.length > 0) {
      const parts: string[] = [];
      if (text) {
        parts.push(text);
      }
      for (const tool of toolCalls) {
        const toolMessages = buildToolMessages(tool);
        parts.push(formatAsJson(toolMessages));
      }
      return parts.join('\n\n');
    }
    return text ?? formatAsJson(content);
  }
  return formatAsJson(content);
}

/**
 * Get the display content for a message based on its category.
 * For assistant messages, content is in content.message.content.
 * For user/system messages, content is in content.content.
 */
export function getDisplayContent(
  content: MessageContent,
  category: MessageCategory | null
): unknown {
  if (category === 'assistant' && content.message?.content) {
    return content.message.content;
  }
  // For user messages with string content in message.content (e.g., /context command output)
  if (category === 'user' && typeof content.message?.content === 'string') {
    return stripXmlTags(content.message.content);
  }
  return content.content;
}
