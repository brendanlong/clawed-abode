/**
 * Tool results as clients see them. Tool cards render collapsed, so a large
 * result's body is replaced by a summary of what the collapsed card shows and
 * fetched only when the card is expanded (`claude.getToolResult`). The
 * projection runs at read time on the server, so stored messages keep the raw
 * SDK content and changing the summary needs no migration.
 */

import { z } from 'zod';
import { parseReadOutput } from './read-output';
import { parseWebSearchOutput } from './web-search-output';

/**
 * Results whose serialized body is at most this long stay inline: answers,
 * acks and short errors then render without a fetch, for ~3% more bytes.
 */
export const INLINE_TOOL_RESULT_MAX_CHARS = 1024;

const toolResultPartSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
  tool_name: z.string().optional(),
});

/** Non-text parts get a short label; their payloads (e.g. base64 images) are never shown. */
function toolResultPartText(part: unknown): string | null {
  if (typeof part === 'string') return part;
  const parsed = toolResultPartSchema.safeParse(part);
  if (!parsed.success) return null;
  const { type, text, tool_name } = parsed.data;
  if (text !== undefined) return text;
  if (type === 'tool_reference' && tool_name) return `Loaded ${tool_name}`;
  return `[${type ?? 'unknown'}]`;
}

/**
 * The display text of a `tool_result`'s content. Any result means the call has
 * finished, so this always returns a string — never undefined, which the tool
 * displays read as still running.
 */
export function toolResultText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map(toolResultPartText)
      .filter((text) => text !== null)
      .join('\n\n');
  }
  return toolResultPartText(content) ?? '';
}

/**
 * The counts collapsed tool cards show. A result message names only its
 * `tool_use_id`, not its tool, so every count is computed for every result and
 * each card reads the one it needs.
 */
export const toolResultSummarySchema = z.object({
  /** Content lines as Read shows them (gutter and system reminders dropped). */
  readLines: z.number(),
  /** Non-blank lines: Glob's files, and Grep's matches outside count mode. */
  nonBlankLines: z.number(),
  /** Sum of each line's trailing `:N`: Grep's matches in count mode. */
  countTotal: z.number(),
  /** WebSearch's sources, or null for empty output. */
  webSearchSources: z.number().nullable(),
  /** The CLI's "Answer questions?" error: an AskUserQuestion still waiting for its answer. */
  awaitingAnswer: z.boolean(),
});
export type ToolResultSummary = z.infer<typeof toolResultSummarySchema>;

/** Summarize a result's display text (see {@link toolResultText}). */
export function summarizeToolResult(text: string): ToolResultSummary {
  const nonBlank = text.split('\n').filter((line) => line.trim().length > 0);
  // Only plausible counts: a long digit run would parse to a huge or infinite number.
  const countTotal = nonBlank.reduce((sum, line) => {
    const count = parseInt(line.split(':').pop()?.trim() ?? '0', 10);
    return Number.isSafeInteger(count) ? Math.min(sum + count, Number.MAX_SAFE_INTEGER) : sum;
  }, 0);
  return {
    readLines: parseReadOutput(text).lineCount,
    nonBlankLines: nonBlank.length,
    countTotal,
    webSearchSources: parseWebSearchOutput(text)?.links.length ?? null,
    awaitingAnswer: text.includes('Answer questions'),
  };
}

/** SDK fields no client reads; dropping them roughly halves a page. */
const UNREAD_TOP_LEVEL_FIELDS = ['tool_use_result', 'wire_tool_inputs'];
const UNREAD_MESSAGE_FIELDS = ['input_transformations'];

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function omit(object: JsonObject, keys: string[]): JsonObject {
  if (!keys.some((key) => key in object)) return object;
  const copy = { ...object };
  for (const key of keys) delete copy[key];
  return copy;
}

/** A `tool_result` block with a large body swapped for its summary. */
function projectBlock(block: unknown): unknown {
  if (!isObject(block) || block.type !== 'tool_result') return block;
  if ((JSON.stringify(block.content) ?? '').length <= INLINE_TOOL_RESULT_MAX_CHARS) return block;
  const { content, ...rest } = block;
  return { ...rest, summary: summarizeToolResult(toolResultText(content)) };
}

/**
 * A stored message's content as clients receive it: unread SDK fields dropped
 * and large tool-result bodies replaced by a summary. Pure, and applied to every
 * message the server sends (history, snapshots, live events).
 */
export function projectMessageContent(content: unknown): unknown {
  if (!isObject(content)) return content;
  const projected = omit(content, UNREAD_TOP_LEVEL_FIELDS);
  const message = projected.message;
  if (!isObject(message)) return projected;
  const trimmed = omit(message, UNREAD_MESSAGE_FIELDS);
  const original: unknown[] | null = Array.isArray(message.content) ? message.content : null;
  const blocks = original?.map(projectBlock) ?? null;
  const blocksChanged = blocks?.some((block, i) => block !== original?.[i]) ?? false;
  if (trimmed === message && !blocksChanged) return projected;
  return { ...projected, message: blocksChanged ? { ...trimmed, content: blocks } : trimmed };
}

/**
 * The full display text of one `tool_result` in a stored message's content, or
 * null when the message has no result for that call.
 */
export function findToolResultText(content: unknown, toolUseId: string): string | null {
  const message = isObject(content) ? content.message : undefined;
  const blocks = isObject(message) && Array.isArray(message.content) ? message.content : [];
  const block = blocks.find(
    (b): b is JsonObject => isObject(b) && b.type === 'tool_result' && b.tool_use_id === toolUseId
  );
  return block ? toolResultText(block.content) : null;
}
