import { z } from 'zod';
import type {
  ContentBlock,
  DisplayMessage,
  MessageBubbleProps,
  MessageContent,
  ToolCall,
  ToolResult,
  ToolResultMap,
} from './types';
import { formatAsJson, buildToolMessages } from './types';
import {
  assistantBlockText,
  getParentToolUseId,
  isTaskNotificationOrigin,
  parseInjectedOrigin,
} from '@/lib/claude-messages';
import { isRenderableBlock, isToolResultMessage, messageDisplay } from '@/lib/transcript-display';
import { isPlanFile, reconstructPlansByToolUseId, type PlanEvent } from './plan-utils';
import { summarizeToolResult, toolResultSummarySchema, toolResultText } from '@/lib/tool-result';
import { memoizeByObject } from '@/lib/memoize-by-object';
import { parseSanitizationInfo } from '@/lib/sanitization';

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
  | 'injectedMessage'
  | 'taskNotification'
  | 'systemError'
  | 'systemCompactBoundary'
  | 'systemRefusalFallback'
  | 'result';

export type RecognitionResult =
  { recognized: true; category: MessageCategory } | { recognized: false };

/**
 * Extract text content from message content blocks.
 * For user/assistant messages, returns the raw markdown text.
 */
export function extractTextContent(content: MessageContent): string | null {
  // For assistant messages, extract text from content.message.content
  if (content.message?.content && Array.isArray(content.message.content)) {
    const textBlocks = content.message.content
      .map(assistantBlockText)
      .filter((text) => text !== null);
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

/** Whether a message is the user's own prompt, which renders right-aligned. */
export function isOwnPromptMessage(message: { type: string; content: unknown }): boolean {
  if (message.type !== 'user') return false;
  const content = message.content as MessageContent;
  return (
    !isToolResultMessage(content) &&
    !parseInjectedOrigin(content.origin) &&
    !isTaskNotificationOrigin(content.origin)
  );
}

/**
 * Extract tool result blocks from a message.
 */
function getToolResults(content: MessageContent): ContentBlock[] {
  const innerContent = content.message?.content;
  if (Array.isArray(innerContent)) {
    return innerContent.filter((block) => block.type === 'tool_result');
  }
  return [];
}

/**
 * Whether an assistant message is purely one or more tool calls, with no other
 * visible content. Consecutive such messages are the "back-to-back tool calls"
 * that should render tightly packed rather than with full inter-message spacing.
 */
export function isToolCallOnlyMessage(content: MessageContent): boolean {
  const blocks = content?.message?.content;
  return (
    Array.isArray(blocks) &&
    blocks.some((block) => block.type === 'tool_use') &&
    blocks.every((block) => block.type === 'tool_use' || !isRenderableBlock(block))
  );
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

  if (type === 'user') {
    // Tool results render on their call, never as a bubble (see isTranscriptRow).
    if (isToolResultMessage(content)) return { recognized: false };
    if (content.subtype === 'interrupt') return { recognized: true, category: 'userInterrupt' };
    if (parseInjectedOrigin(content.origin))
      return { recognized: true, category: 'injectedMessage' };
    if (isTaskNotificationOrigin(content.origin))
      return { recognized: true, category: 'taskNotification' };
    // Prompts carry text blocks, a string message.content (e.g. /context command
    // output), or a simple content string.
    const inner = content.message?.content;
    if (Array.isArray(inner) || typeof inner === 'string' || typeof content.content === 'string') {
      return { recognized: true, category: 'user' };
    }
    return { recognized: false };
  }

  // The only system messages shown in the transcript are errors, compact
  // boundaries, and refusal fallbacks (see isTranscriptRow). Every other system
  // subtype — init, hooks, generic notices — is filtered out before rendering,
  // so it is intentionally not given a category here.
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
  return { name: block.name || 'Unknown', id: block.id, input: block.input, result };
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
 * Whether a `MessageBubble` can skip re-rendering. Lists hand every bubble the
 * whole transcript's result map, rebuilt on every update (each streamed partial,
 * each older page), so the bubble compares only the entries its own calls read;
 * the rest of the transcript changing doesn't concern it. Results are compared
 * by reference, which holds while their message stays cached (see `toToolResult`).
 */
export function messageBubblePropsEqual(
  prev: MessageBubbleProps,
  next: MessageBubbleProps
): boolean {
  const a = prev.message;
  const b = next.message;
  if (
    a.id !== b.id ||
    a.type !== b.type ||
    a.content !== b.content ||
    a.createdAt !== b.createdAt
  ) {
    return false;
  }
  if (prev.toolResults === next.toolResults) return true;
  const blocks = (b.content as MessageContent | null | undefined)?.message?.content;
  if (!Array.isArray(blocks)) return true;
  return blocks.every(
    (block) =>
      block.type !== 'tool_use' ||
      !block.id ||
      prev.toolResults?.get(block.id) === next.toolResults?.get(block.id)
  );
}

/**
 * Fill in the text of every result the server elided, so the calls carry their
 * full output (for copying). Fetches run in parallel and share one batch.
 */
export async function loadToolResultTexts(
  toolCalls: ToolCall[],
  load: (messageId: string, toolUseId: string) => Promise<string>
): Promise<ToolCall[]> {
  return Promise.all(
    toolCalls.map(async (tool) => {
      const { result } = tool;
      if (!result || result.text !== undefined || !tool.id) return tool;
      return { ...tool, result: { ...result, text: await load(result.messageId, tool.id) } };
    })
  );
}

/** Whether any of these calls has a result whose text the server elided. */
export function hasElidedResults(toolCalls: ToolCall[]): boolean {
  return toolCalls.some((tool) => tool.result !== undefined && tool.result.text === undefined);
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

type ToolUseBlock = ContentBlock & { id: string };

function assistantContentBlocks(message: DisplayMessage): ContentBlock[] {
  if (message.type !== 'assistant') return [];
  const blocks = (message.content as MessageContent | undefined)?.message?.content;
  return Array.isArray(blocks) ? blocks : [];
}

/**
 * Every identified `tool_use` block across the assistant messages (top-level and
 * subagent alike), paired with the message carrying it, in transcript order. The
 * single traversal behind every tool-call scan below — add new scans on top of
 * it rather than re-walking `content.message.content`.
 */
export function* toolUseBlocks(
  messages: DisplayMessage[]
): Generator<{ block: ToolUseBlock; message: DisplayMessage }> {
  for (const message of messages) {
    for (const block of assistantContentBlocks(message)) {
      if (block.type === 'tool_use' && block.id) yield { block: block as ToolUseBlock, message };
    }
  }
}

/** Badges for an elided result whose summary doesn't validate: blank, but the body still loads. */
const EMPTY_SUMMARY = summarizeToolResult('');

/**
 * A `tool_result` block as a {@link ToolResult}. The server sets `summary`
 * exactly when it elided the body, so its presence (not whether it validates)
 * decides that the text must be fetched; an inline body is summarized here the
 * same way the server would. Memoized by block, so a result keeps its identity
 * while its message stays cached and {@link messageBubblePropsEqual} can compare
 * by reference (a block belongs to one message, so the id is fixed per block).
 */
const toToolResult = memoizeByObject((block: ContentBlock, messageId: string): ToolResult => {
  const sanitization = parseSanitizationInfo(block.sanitization) ?? undefined;
  const base = { messageId, is_error: block.is_error, sanitization };
  if (block.summary !== undefined) {
    const parsed = toolResultSummarySchema.safeParse(block.summary);
    return { ...base, summary: parsed.success ? parsed.data : EMPTY_SUMMARY };
  }
  const text = toolResultText(block.content);
  return { ...base, summary: summarizeToolResult(text), text };
});

/**
 * Pair every `tool_result` with its `tool_use`, and report where each result
 * landed, which is a foreground subagent's finish point. A result whose call
 * isn't loaded is left out; tool-result messages never render on their own.
 */
export function buildToolResultMap(messages: DisplayMessage[]): {
  resultMap: ToolResultMap;
  resultSequenceByToolUseId: Map<string, number>;
} {
  const resultMap: ToolResultMap = new Map();
  const resultSequenceByToolUseId = new Map<string, number>();

  const toolUseIds = new Set<string>();
  for (const { block } of toolUseBlocks(messages)) {
    toolUseIds.add(block.id);
  }

  for (const msg of messages) {
    if (msg.type !== 'user') continue;
    for (const block of getToolResults(msg.content as MessageContent)) {
      if (block.tool_use_id && toolUseIds.has(block.tool_use_id)) {
        resultMap.set(block.tool_use_id, toToolResult(block, msg.id));
        resultSequenceByToolUseId.set(block.tool_use_id, msg.sequence);
      }
    }
  }

  return { resultMap, resultSequenceByToolUseId };
}

function isSubagentCall(block: ContentBlock): boolean {
  return block.name === 'Agent' || block.name === 'Task';
}

/**
 * Collect the lifecycle of each top-level (main-agent) subagent `Agent`/`Task`
 * call, and index those call blocks by id so a relocated box can be rebuilt from
 * its call. Background subagents are identified by a `task_started` system
 * message and finished by a `task_notification`; both carry the subagent's
 * `tool_use_id`. Lifecycles come back in spawn order.
 */
export function collectSubagentLifecycles(
  messages: DisplayMessage[],
  subagentMessagesByToolUseId: Map<string, DisplayMessage[]>,
  resultSequenceByToolUseId: Map<string, number>
): { lifecycles: SubagentLifecycle[]; agentBlockById: Map<string, ContentBlock> } {
  const agentBlockById = new Map<string, ContentBlock>();
  const spawnSequenceByToolUseId = new Map<string, number>();
  const backgroundToolUseIds = new Set<string>();
  const notificationSequenceByToolUseId = new Map<string, number>();

  for (const { block, message } of toolUseBlocks(messages)) {
    if (!isSubagentCall(block)) continue;
    if (getParentToolUseId(message.content) !== null) continue;
    agentBlockById.set(block.id, block);
    spawnSequenceByToolUseId.set(block.id, message.sequence);
  }

  for (const msg of messages) {
    if (msg.type !== 'system') continue;
    const content = msg.content as { subtype?: string; tool_use_id?: string } | undefined;
    const toolUseId = content?.tool_use_id;
    if (!toolUseId) continue;
    if (content.subtype === 'task_started') {
      backgroundToolUseIds.add(toolUseId);
    } else if (
      content.subtype === 'task_notification' &&
      !notificationSequenceByToolUseId.has(toolUseId)
    ) {
      // First terminal notification wins as the finish point.
      notificationSequenceByToolUseId.set(toolUseId, msg.sequence);
    }
  }

  const lifecycles: SubagentLifecycle[] = [];
  for (const [toolUseId, spawnSequence] of spawnSequenceByToolUseId) {
    const children = subagentMessagesByToolUseId.get(toolUseId);
    // reduce (not Math.max(...spread)) to avoid an argument-count limit on a
    // chatty subagent's large child array, and without assuming child order.
    const lastChildSequence = children?.length
      ? children.reduce((max, c) => Math.max(max, c.sequence), -Infinity)
      : null;
    lifecycles.push({
      toolUseId,
      spawnSequence,
      isBackground: backgroundToolUseIds.has(toolUseId),
      notificationSequence: notificationSequenceByToolUseId.get(toolUseId) ?? null,
      lastChildSequence,
      resultSequence: resultSequenceByToolUseId.get(toolUseId) ?? null,
    });
  }
  return { lifecycles, agentBlockById };
}

/**
 * The id of the most recent `TodoWrite` call — the one list that renders
 * expanded. Scans backwards, so on a long transcript it stops at the newest
 * assistant message that has one. Assumes `messages` is chronological.
 */
export function getLatestTodoWriteId(messages: DisplayMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = assistantContentBlocks(messages[i]);
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j];
      if (block.type === 'tool_use' && block.name === 'TodoWrite' && block.id) return block.id;
    }
  }
  return null;
}

/**
 * Reconstruct the plan content shown by each `ExitPlanMode` call (keyed by its
 * tool_use id) from the plan-file `Write`/`Edit` calls that preceded it. See
 * {@link reconstructPlansByToolUseId} for the multi-plan semantics.
 */
export function getPlanContentByToolUseId(messages: DisplayMessage[]): Map<string, string> {
  const events: PlanEvent[] = [];
  for (const { block, message } of toolUseBlocks(messages)) {
    if (block.name === 'ExitPlanMode') {
      events.push({ kind: 'exit', sequence: message.sequence, toolUseId: block.id });
      continue;
    }
    if (block.name !== 'Write' && block.name !== 'Edit') continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const filePath = input.file_path;
    if (typeof filePath !== 'string' || !isPlanFile(filePath)) continue;

    if (block.name === 'Write') {
      events.push({
        kind: 'write',
        sequence: message.sequence,
        filePath,
        content: (input.content as string) ?? '',
      });
    } else {
      events.push({
        kind: 'edit',
        sequence: message.sequence,
        filePath,
        oldString: (input.old_string as string) ?? '',
        newString: (input.new_string as string) ?? '',
      });
    }
  }
  return reconstructPlansByToolUseId(events);
}

const retractedUuidsSchema = z.array(z.string()).catch([]);

/**
 * Fold the messages a `model_refusal_fallback` retracted (the primary model's
 * attempt, which the fallback model redoes) under that fallback banner, keyed by
 * the banner's message id. Matches on the SDK `uuid` of each candidate against
 * the banner's `retracted_message_uuids`; uuids whose message isn't loaded are
 * ignored, so a partially loaded retraction folds what it can.
 *
 * The API retracts only the model's turn, not its side effects, so a retracted
 * subagent spawn stays put: its subagent really ran, and its box is placed
 * relative to the spawn row.
 */
export function collectRetractedMessages(
  candidates: DisplayMessage[]
): Map<string, DisplayMessage[]> {
  const fallbackIdByUuid = new Map<string, string>();
  for (const message of candidates) {
    const content = message.content as MessageContent;
    if (message.type !== 'system' || content.subtype !== 'model_refusal_fallback') continue;
    for (const uuid of retractedUuidsSchema.parse(content.retracted_message_uuids)) {
      fallbackIdByUuid.set(uuid, message.id);
    }
  }

  const retracted = new Map<string, DisplayMessage[]>();
  if (fallbackIdByUuid.size === 0) return retracted;
  const spawnsSubagent = new Set(
    [...toolUseBlocks(candidates)]
      .filter(({ block }) => isSubagentCall(block))
      .map(({ message }) => message.id)
  );
  for (const message of candidates) {
    const uuid = (message.content as MessageContent).uuid;
    const fallbackId = uuid === undefined ? undefined : fallbackIdByUuid.get(uuid);
    if (fallbackId === undefined || spawnsSubagent.has(message.id)) continue;
    const existing = retracted.get(fallbackId);
    if (existing) {
      existing.push(message);
    } else {
      retracted.set(fallbackId, [message]);
    }
  }
  return retracted;
}

/** One top-level transcript row: a message, or a relocated finished-subagent box. */
export type TranscriptRow =
  | { kind: 'message'; sequence: number; message: DisplayMessage }
  | { kind: 'taskbox'; sequence: number; toolUseId: string; tool: ToolCall };

/** A row's React key: unique across both kinds of row. */
export function transcriptRowKey(row: TranscriptRow): string {
  return row.kind === 'message' ? row.message.id : `taskbox-${row.toolUseId}`;
}

export interface TranscriptLayout {
  resultMap: ToolResultMap;
  subagentMessagesByToolUseId: Map<string, DisplayMessage[]>;
  /** Top-level rows in sequence order. */
  rows: TranscriptRow[];
  /** Running subagent boxes, pinned below the rows in spawn order. */
  pinnedSubagents: { toolUseId: string; tool: ToolCall }[];
  /** Subagents whose box renders in `rows` or `pinnedSubagents`, not at the spawn point. */
  relocatedSubagentIds: Set<string>;
  /** Retracted messages folded under their refusal-fallback banner, keyed by its message id. */
  retractedMessagesByFallbackId: Map<string, DisplayMessage[]>;
}

/**
 * Everything the top-level transcript renders, derived from the chronological
 * message list: tool results paired onto their calls, subagent messages grouped
 * under their Task, retracted messages folded under their refusal-fallback banner,
 * and subagent boxes placed (see {@link SubagentPlacements}).
 */
export function buildTranscriptLayout(
  messages: DisplayMessage[],
  isSessionRunning: boolean
): TranscriptLayout {
  const { resultMap, resultSequenceByToolUseId } = buildToolResultMap(messages);
  const subagentMessagesByToolUseId = groupSubagentMessages(messages);
  const { lifecycles, agentBlockById } = collectSubagentLifecycles(
    messages,
    subagentMessagesByToolUseId,
    resultSequenceByToolUseId
  );

  // The same classification the server stores as `Message.display` and pages
  // history by.
  const topLevelMessages = messages.filter(
    (msg) => messageDisplay(msg.type, msg.content) === 'row'
  );
  const retractedMessagesByFallbackId = collectRetractedMessages(topLevelMessages);
  const retractedIds = new Set(
    [...retractedMessagesByFallbackId.values()].flat().map((message) => message.id)
  );
  const visibleMessages = topLevelMessages.filter((msg) => !retractedIds.has(msg.id));

  // Interleaving is measured against the top-level rows that actually render, so
  // a plain foreground wait (subagent with no rows between spawn and finish) stays
  // inline.
  const placements = computeSubagentPlacements(
    lifecycles,
    visibleMessages.map((m) => m.sequence),
    isSessionRunning
  );

  // Merge relocated finished-subagent boxes into the message rows by sequence so
  // each box lands at its finish position. The sort is stable, so a box sharing a
  // sequence with a message row follows it.
  const rows: TranscriptRow[] = visibleMessages.map((message) => ({
    kind: 'message',
    sequence: message.sequence,
    message,
  }));
  for (const { toolUseId, atSequence } of placements.finished) {
    const block = agentBlockById.get(toolUseId);
    if (!block) continue;
    rows.push({
      kind: 'taskbox',
      sequence: atSequence,
      toolUseId,
      tool: buildToolCallFromBlock(block, resultMap),
    });
  }
  rows.sort((a, b) => a.sequence - b.sequence);

  const pinnedSubagents: TranscriptLayout['pinnedSubagents'] = [];
  for (const toolUseId of placements.running) {
    const block = agentBlockById.get(toolUseId);
    if (block) pinnedSubagents.push({ toolUseId, tool: buildToolCallFromBlock(block, resultMap) });
  }

  return {
    resultMap,
    subagentMessagesByToolUseId,
    rows,
    pinnedSubagents,
    relocatedSubagentIds: placements.relocatedIds,
    retractedMessagesByFallbackId,
  };
}
