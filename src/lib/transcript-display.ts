/**
 * How a stored message takes part in the transcript, decided from the message
 * alone. The one classifier shared by the server, which stores it on every row
 * (`Message.display`) so history pages by rendered rows, and the client, which
 * picks the rows it renders with it. The migration that backfilled the column
 * restates it in SQL; `message-store.integration.test.ts` keeps the two in
 * agreement.
 */

import { z } from 'zod';
import { memoizeByObject } from './memoize-by-object';

/**
 * - `row`: renders as its own top-level transcript row (counts toward a history page).
 * - `context`: never a top-level row, but rows that are need it: tool results
 *   (shown on their call), background-task lifecycle events (place subagent
 *   boxes), and subagent messages (shown inside their Task box).
 * - `hidden`: nothing on the client reads it, so it is neither paged nor streamed.
 */
export type MessageDisplay = 'row' | 'context' | 'hidden';

/** System subtypes shown in the transcript; the rest are noise (issue #312). */
const VISIBLE_SYSTEM_SUBTYPES = new Set(['error', 'compact_boundary', 'model_refusal_fallback']);

/** Hidden system subtypes the client still reads to place background-subagent boxes. */
const TASK_LIFECYCLE_SUBTYPES = new Set(['task_started', 'task_notification']);

const optionalString = z.string().optional().catch(undefined);

const blockSchema = z
  .object({ type: z.string(), text: z.unknown().optional(), thinking: z.unknown().optional() })
  .catch({ type: '', text: undefined, thinking: undefined });

const contentSchema = z
  .object({
    subtype: optionalString,
    parent_tool_use_id: z.string().nullish().catch(null),
    message: z
      .object({ content: z.array(blockSchema).optional().catch(undefined) })
      .nullish()
      .catch(undefined),
  })
  .catch({ subtype: undefined, parent_tool_use_id: null, message: undefined });

/**
 * Whether a block's text has anything but ASCII whitespace (space, \t, \n, \v,
 * \f, \r) — exactly the set the backfill migration trims in SQL, so the stored
 * and live classifications can't disagree.
 */
function hasText(text: unknown): boolean {
  return typeof text === 'string' && /[^ \t\n\v\f\r]/.test(text);
}

/**
 * Whether an assistant content block renders a visible element — e.g. a
 * `thinking` block with empty text (just a continuity signature) renders nothing.
 * A `thinking` block with text is a progress update (see `assistantBlockText`).
 * `advisor_tool_result` is encrypted, so its `server_tool_use` is the indicator.
 *
 * Keep the renderable cases in sync with `ContentRenderer.renderContentBlocks`.
 */
export function isRenderableBlock(block: {
  type: string;
  text?: unknown;
  thinking?: unknown;
}): boolean {
  switch (block.type) {
    case 'text':
      return hasText(block.text);
    case 'thinking':
      return hasText(block.thinking);
    case 'tool_use':
    case 'redacted_thinking':
    case 'server_tool_use':
      return true;
    default:
      return false;
  }
}

interface ParsedContent {
  subtype: string | undefined;
  parentToolUseId: string | null;
  /** `message.content` when it is an array of blocks, else null. */
  blocks: z.infer<typeof blockSchema>[] | null;
}

/**
 * The fields the classifier reads, validated once per content object: the client
 * re-classifies its whole cached transcript on every update (each streamed
 * partial), and the messages it keeps keep their content objects.
 */
function parseContent(content: unknown): ParsedContent {
  return typeof content === 'object' && content !== null
    ? parseObjectContent(content)
    : validateContent(content);
}

const parseObjectContent = memoizeByObject((content: object) => validateContent(content));

function validateContent(content: unknown): ParsedContent {
  const parsed = contentSchema.parse(content);
  return {
    subtype: parsed.subtype,
    parentToolUseId: parsed.parent_tool_use_id ?? null,
    blocks: parsed.message?.content ?? null,
  };
}

function hasRenderableBlocks({ blocks }: ParsedContent): boolean {
  // Non-array content is handled by other display paths, so it counts.
  return blocks === null || blocks.some(isRenderableBlock);
}

function hasToolResultBlocks({ blocks }: ParsedContent): boolean {
  return blocks?.some((block) => block.type === 'tool_result') ?? false;
}

function isHiddenSystem(type: string, { subtype }: ParsedContent): boolean {
  return type === 'system' && (subtype === undefined || !VISIBLE_SYSTEM_SUBTYPES.has(subtype));
}

function isRow(type: string, parsed: ParsedContent): boolean {
  if (isHiddenSystem(type, parsed)) return false;
  if (type === 'user' && hasToolResultBlocks(parsed)) return false;
  if (type === 'assistant' && !hasRenderableBlocks(parsed)) return false;
  return true;
}

/** Whether a message carries `tool_result` blocks (a `user` message reporting tool output). */
export function isToolResultMessage(content: unknown): boolean {
  return hasToolResultBlocks(parseContent(content));
}

/**
 * Whether a message renders as a row of whichever transcript holds it: the
 * top-level list, or the nested transcript of the subagent that sent it. Tool
 * results never do (they render on their call; one whose call was never stored
 * is dropped), nor do hidden system messages or empty assistant fragments.
 */
export function isTranscriptRow(type: string, content: unknown): boolean {
  return isRow(type, parseContent(content));
}

/** Classify a stored message; see {@link MessageDisplay}. */
export function messageDisplay(type: string, content: unknown): MessageDisplay {
  const parsed = parseContent(content);
  if (isRow(type, parsed)) return parsed.parentToolUseId === null ? 'row' : 'context';
  if (type === 'user' && hasToolResultBlocks(parsed)) return 'context';
  if (type === 'system' && parsed.subtype && TASK_LIFECYCLE_SUBTYPES.has(parsed.subtype)) {
    return 'context';
  }
  return 'hidden';
}
