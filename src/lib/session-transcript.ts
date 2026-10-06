import { z } from 'zod';

/**
 * A condensed, text-only view of a session's transcript, for one agent reading
 * another session's output. Only the main conversation is kept: subagent traffic,
 * thinking, tool results, and hidden system messages are dropped.
 */
export interface TranscriptEntry {
  sequence: number;
  role: 'user' | 'assistant' | 'tool_call' | 'error';
  text: string;
}

const userPromptSchema = z.object({ type: z.literal('user'), content: z.string() });

const contentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), name: z.string(), input: z.unknown() }),
  z.object({ type: z.string() }),
]);

const assistantSchema = z.object({
  type: z.literal('assistant'),
  parent_tool_use_id: z.string().nullish(),
  message: z.object({ content: z.array(contentBlockSchema) }),
});

const systemErrorSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('error'),
  content: z.array(contentBlockSchema),
});

const TOOL_INPUT_PREVIEW_CHARS = 200;

export function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}… [truncated]` : text;
}

function blockTexts(blocks: z.infer<typeof contentBlockSchema>[]): string[] {
  return blocks.flatMap((block) =>
    block.type === 'text' && 'text' in block && block.text.trim() ? [block.text] : []
  );
}

/** Condense stored messages (oldest-first) into transcript entries. */
export function toTranscriptEntries(
  messages: { sequence: number; content: unknown }[],
  { includeToolCalls }: { includeToolCalls: boolean }
): TranscriptEntry[] {
  return messages.flatMap(({ sequence, content }): TranscriptEntry[] => {
    const prompt = userPromptSchema.safeParse(content);
    if (prompt.success) return [{ sequence, role: 'user', text: prompt.data.content }];

    const error = systemErrorSchema.safeParse(content);
    if (error.success) {
      return [{ sequence, role: 'error', text: blockTexts(error.data.content).join('\n') }];
    }

    const assistant = assistantSchema.safeParse(content);
    if (!assistant.success || assistant.data.parent_tool_use_id) return [];
    return assistant.data.message.content.flatMap((block): TranscriptEntry[] => {
      if (block.type === 'text' && 'text' in block && block.text.trim()) {
        return [{ sequence, role: 'assistant', text: block.text }];
      }
      if (includeToolCalls && block.type === 'tool_use' && 'name' in block) {
        const input = truncate(JSON.stringify(block.input) ?? '', TOOL_INPUT_PREVIEW_CHARS);
        return [{ sequence, role: 'tool_call', text: `${block.name} ${input}` }];
      }
      return [];
    });
  });
}

function formatEntry({ sequence, role, text }: TranscriptEntry, maxChars: number): string {
  return `[#${sequence} ${role}] ${truncate(text, maxChars)}`;
}

export interface FittedTranscript {
  text: string;
  /** Sequence of the oldest message included; undefined when nothing was. */
  oldestSequence: number | undefined;
  /** Whether every entry fit. */
  complete: boolean;
}

/**
 * Render the newest entries (given oldest-first) that fit in `budgetChars`, each
 * capped at `maxCharsPerEntry`. Cuts only between messages, since a page cursor
 * is a message sequence and a message split across pages would lose its rest;
 * the newest message is always kept.
 */
export function fitNewestEntries(
  entries: TranscriptEntry[],
  maxCharsPerEntry: number,
  budgetChars: number
): FittedTranscript {
  const kept: string[] = [];
  let used = 0;
  let oldestSequence: number | undefined;
  let end = entries.length;
  while (end > 0) {
    const sequence = entries[end - 1]!.sequence;
    let start = end - 1;
    while (start > 0 && entries[start - 1]!.sequence === sequence) start--;
    const rendered = entries.slice(start, end).map((e) => formatEntry(e, maxCharsPerEntry));
    const size = rendered.reduce((sum, r) => sum + r.length + 2, 0);
    if (kept.length > 0 && used + size > budgetChars) {
      return { text: kept.join('\n\n'), oldestSequence, complete: false };
    }
    kept.unshift(...rendered);
    used += size;
    oldestSequence = sequence;
    end = start;
  }
  return { text: kept.join('\n\n'), oldestSequence, complete: true };
}
