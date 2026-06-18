/**
 * Accumulates stream_event messages from the Agent SDK into partial assistant messages.
 *
 * When includePartialMessages is enabled, the SDK emits a series of stream_events
 * (message_start, content_block_start, content_block_delta, content_block_stop,
 * message_delta, message_stop) before the final complete AssistantMessage.
 *
 * This accumulator builds up a synthetic partial assistant message from those events
 * so the UI can show real-time progress. The partial message uses the stream_event's
 * UUID as its ID. When the final AssistantMessage arrives (with a different UUID),
 * the frontend replaces the partial with the final version.
 */

/**
 * A partial assistant message built from accumulated stream events.
 * Shaped to match the assistant message content structure so the frontend
 * can render it identically to a complete message.
 */
export interface PartialAssistantMessage {
  type: 'assistant';
  partial: true;
  message: {
    role: 'assistant';
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    >;
    model?: string;
    stop_reason?: string | null;
  };
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}

/**
 * Represents a content block being accumulated from stream deltas.
 *
 * Every content_block_start pushes one entry (including blocks we don't render,
 * as `other`) so that `event.index` stays aligned with this array.
 */
interface AccumulatingContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'other';
  /** For text and thinking blocks */
  text?: string;
  /** For tool_use blocks */
  id?: string;
  name?: string;
  input?: string; // accumulated JSON string, parsed at emission time
}

/**
 * Streaming event structure from the Anthropic API.
 * We use loose typing here since these come from the SDK as opaque objects.
 */
interface StreamEvent {
  type: string;
  message?: {
    model?: string;
    role?: string;
    [key: string]: unknown;
  };
  index?: number;
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    text?: string;
    thinking?: string;
    [key: string]: unknown;
  };
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Accumulates stream_event deltas into partial assistant messages.
 *
 * Usage:
 *   const acc = new StreamAccumulator();
 *   // For each stream_event from the SDK:
 *   const partial = acc.accumulate(streamEventMessage);
 *   if (partial) {
 *     // Emit this partial to connected clients
 *   }
 *   // When a full assistant message arrives, call reset()
 */
export class StreamAccumulator {
  private contentBlocks: AccumulatingContentBlock[] = [];
  private model: string | undefined;
  private stopReason: string | null = null;
  private parentToolUseId: string | null = null;
  private uuid: string = '';
  private sessionId: string = '';
  private active = false;

  /**
   * Process a stream_event and return a partial assistant message if content has changed.
   * Returns null if the event doesn't produce a meaningful update.
   */
  accumulate(message: {
    type: 'stream_event';
    event: StreamEvent;
    parent_tool_use_id: string | null;
    uuid: string;
    session_id: string;
  }): PartialAssistantMessage | null {
    const event = message.event;

    // Store metadata from the stream_event wrapper
    this.parentToolUseId = message.parent_tool_use_id;
    this.uuid = message.uuid;
    this.sessionId = message.session_id;

    switch (event.type) {
      case 'message_start': {
        this.active = true;
        this.contentBlocks = [];
        this.model = event.message?.model;
        this.stopReason = null;
        // Don't emit for message_start alone - no content yet
        return null;
      }

      case 'content_block_start': {
        if (!this.active) return null;
        const block = event.content_block;
        if (!block) return null;

        // Push one entry per block (even unrendered ones) so event.index stays
        // aligned with this.contentBlocks for subsequent deltas.
        if (block.type === 'text') {
          this.contentBlocks.push({ type: 'text', text: block.text ?? '' });
        } else if (block.type === 'thinking') {
          this.contentBlocks.push({ type: 'thinking', text: block.thinking ?? '' });
        } else if (block.type === 'tool_use') {
          this.contentBlocks.push({
            type: 'tool_use',
            id: block.id ?? '',
            name: block.name ?? '',
            input: '',
          });
        } else {
          // Unknown/unrendered block (e.g. redacted_thinking) — keep a placeholder
          // so indices line up, but it is dropped at emission time.
          this.contentBlocks.push({ type: 'other' });
        }
        // Emit after adding a new block (shows tool_use / thinking starting)
        return this.buildPartial();
      }

      case 'content_block_delta': {
        if (!this.active) return null;
        const delta = event.delta;
        if (!delta) return null;

        const blockIndex = event.index ?? this.contentBlocks.length - 1;
        const currentBlock = this.contentBlocks[blockIndex];
        if (!currentBlock) return null;

        if (delta.type === 'text_delta' && currentBlock.type === 'text') {
          currentBlock.text = (currentBlock.text ?? '') + (delta.text ?? '');
          return this.buildPartial();
        }

        if (delta.type === 'thinking_delta' && currentBlock.type === 'thinking') {
          currentBlock.text = (currentBlock.text ?? '') + (delta.thinking ?? '');
          return this.buildPartial();
        }

        if (delta.type === 'input_json_delta' && currentBlock.type === 'tool_use') {
          currentBlock.input = (currentBlock.input ?? '') + (delta.partial_json ?? '');
          return this.buildPartial();
        }

        return null;
      }

      case 'content_block_stop': {
        // Block finished - emit current state
        if (!this.active) return null;
        return this.buildPartial();
      }

      case 'message_delta': {
        if (!this.active) return null;
        if (event.delta?.stop_reason) {
          this.stopReason = event.delta.stop_reason;
        }
        return this.buildPartial();
      }

      case 'message_stop': {
        // Message complete - the full AssistantMessage will follow
        // Emit final partial state, then caller should reset
        if (!this.active) return null;
        const final = this.buildPartial();
        return final;
      }

      default:
        return null;
    }
  }

  /**
   * Build the current partial assistant message from accumulated state.
   */
  private buildPartial(): PartialAssistantMessage | null {
    if (!this.active || this.contentBlocks.length === 0) return null;

    const content: PartialAssistantMessage['message']['content'] = [];
    for (const block of this.contentBlocks) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text ?? '' });
      } else if (block.type === 'thinking') {
        content.push({ type: 'thinking', thinking: block.text ?? '' });
      } else if (block.type === 'tool_use') {
        let parsedInput: Record<string, unknown> = {};
        if (block.input) {
          try {
            parsedInput = JSON.parse(block.input) as Record<string, unknown>;
          } catch {
            // Input JSON is still partial/incomplete - that's expected during streaming
            // Store the raw partial JSON so the UI can show something
            parsedInput = { _partial_json: block.input };
          }
        }
        content.push({
          type: 'tool_use',
          id: block.id ?? '',
          name: block.name ?? '',
          input: parsedInput,
        });
      }
      // 'other' placeholder blocks are intentionally dropped
    }

    // Nothing renderable yet (e.g. only placeholder blocks) — don't emit.
    if (content.length === 0) return null;

    return {
      type: 'assistant',
      partial: true,
      message: {
        role: 'assistant',
        content,
        model: this.model,
        stop_reason: this.stopReason,
      },
      parent_tool_use_id: this.parentToolUseId,
      uuid: this.uuid,
      session_id: this.sessionId,
    };
  }

  /**
   * Reset the accumulator state. Call this when a full AssistantMessage arrives.
   */
  reset(): void {
    this.contentBlocks = [];
    this.model = undefined;
    this.stopReason = null;
    this.parentToolUseId = null;
    this.uuid = '';
    this.sessionId = '';
    this.active = false;
  }

  /**
   * Whether the accumulator is currently building a partial message.
   */
  get isActive(): boolean {
    return this.active;
  }

  /**
   * The UUID of the current partial message being accumulated.
   * Returns empty string if not active.
   */
  get currentUuid(): string {
    return this.uuid;
  }
}
