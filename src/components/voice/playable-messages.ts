/**
 * Which assistant messages have text worth speaking aloud. Shared by the voice
 * panel's prev/next navigation and the auto-read queue; both parse messages
 * through `messageHelpers` so there is exactly one message parser on the client.
 */

import { isPartialMessageId } from '@/lib/message-cache';
import { extractTextContent, isToolResultMessage } from '@/components/messages/messageHelpers';
import type { DisplayMessage, MessageContent } from '@/components/messages/types';

/** An assistant message with meaningful text content, ready for TTS. */
export interface PlayableMessage {
  id: string;
  text: string;
}

function asContent(msg: DisplayMessage): MessageContent {
  return (msg.content ?? {}) as MessageContent;
}

/**
 * The concatenated text blocks of an assistant message, or null when there is
 * nothing to speak (tool-only, whitespace-only, or malformed content).
 */
export function extractAssistantText(msg: DisplayMessage): string | null {
  const text = extractTextContent(asContent(msg));
  return text && text.trim() ? text : null;
}

/** Every complete (non-partial) assistant message with speakable text, in order. */
export function getAssistantTextMessages(messages: DisplayMessage[]): PlayableMessage[] {
  const results: PlayableMessage[] = [];
  for (const msg of messages) {
    if (msg.type !== 'assistant' || isPartialMessageId(msg.id)) continue;
    const text = extractAssistantText(msg);
    if (text !== null) results.push({ id: msg.id, text });
  }
  return results;
}

/**
 * Speakable assistant messages from the current turn (after the last user-sent
 * prompt; tool results are also `user` messages but don't start a turn) that
 * haven't been queued yet. Called repeatedly while a turn streams so playback
 * starts as messages arrive rather than at turn end.
 */
export function getNewAutoReadMessages(
  messages: DisplayMessage[],
  queuedIds: ReadonlySet<string>
): PlayableMessage[] {
  let turnStartIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'user' && !isToolResultMessage(asContent(msg))) {
      turnStartIndex = i + 1;
      break;
    }
  }
  return getAssistantTextMessages(messages.slice(turnStartIndex)).filter(
    (m) => !queuedIds.has(m.id)
  );
}

/**
 * Auto-read bookkeeping between renders. `queuedIds` (read or deliberately
 * skipped) only grows — ids are unique and `getNewAutoReadMessages` already
 * scopes to the current turn — so a turn whose running flag lands before its
 * prompt can't re-read the last turn.
 */
export interface AutoReadState {
  wasRunning: boolean;
  queuedIds: ReadonlySet<string>;
  /** The user stopped playback; nothing more is queued until the next turn or send. */
  stopped: boolean;
}

export const INITIAL_AUTO_READ_STATE: AutoReadState = {
  wasRunning: false,
  queuedIds: new Set(),
  stopped: false,
};

export type AutoReadEvent =
  /** The transcript or turn state changed. */
  | { type: 'update'; isRunning: boolean; messages: DisplayMessage[]; enabled: boolean }
  /** The user stopped playback: stay quiet for the rest of this turn. */
  | { type: 'playbackStopped' }
  /**
   * The user sent a prompt (the caller stops current playback). What's on screen
   * now is skipped, but auto-read resumes for the replies — a mid-turn send keeps
   * the session running, so waiting for the next turn start would mute them.
   */
  | { type: 'promptSent'; messages: DisplayMessage[] };

function withQueued(ids: ReadonlySet<string>, added: PlayableMessage[]): ReadonlySet<string> {
  return added.length ? new Set([...ids, ...added.map((m) => m.id)]) : ids;
}

/** Advance auto-read by one event; `toEnqueue` is what to hand the speech player now. */
export function autoReadStep(
  state: AutoReadState,
  event: AutoReadEvent
): { state: AutoReadState; toEnqueue: PlayableMessage[] } {
  switch (event.type) {
    case 'playbackStopped':
      return { state: { ...state, stopped: true }, toEnqueue: [] };
    case 'promptSent': {
      const skipped = getNewAutoReadMessages(event.messages, state.queuedIds);
      return {
        state: { ...state, stopped: false, queuedIds: withQueued(state.queuedIds, skipped) },
        toEnqueue: [],
      };
    }
    case 'update': {
      const { isRunning, messages, enabled } = event;
      const turnStarted = isRunning && !state.wasRunning;
      const stopped = state.stopped && !turnStarted;
      // While running, plus one final pass as the turn ends to catch messages that
      // arrived in the same render as the running flag dropping.
      const inTurn = isRunning || state.wasRunning;
      const fresh = inTurn && enabled ? getNewAutoReadMessages(messages, state.queuedIds) : [];
      // Messages arriving after a stop are marked as handled too, so a next turn
      // whose running flag lands before its prompt can't read them out.
      const toEnqueue = stopped ? [] : fresh;
      return {
        state: { wasRunning: isRunning, stopped, queuedIds: withQueued(state.queuedIds, fresh) },
        toEnqueue,
      };
    }
  }
}
