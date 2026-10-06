import { useCallback, useEffect, useRef } from 'react';
import {
  autoReadStep,
  INITIAL_AUTO_READ_STATE,
  type AutoReadEvent,
} from '@/components/voice/playable-messages';
import type { DisplayMessage } from '@/components/messages/types';
import type { VoicePlaybackState } from '@/hooks/useVoicePlayback';

interface AutoReadInput {
  isRunning: boolean;
  messages: DisplayMessage[];
  /** Auto-read is on and TTS is available. */
  enabled: boolean;
}

/**
 * Streams each turn's assistant text into the speech player as it arrives (the
 * rules are the pure `autoReadStep`). Returns the stop to give playback controls
 * and the callback to run when the user sends a prompt; both stop playback.
 */
export function useAutoRead(
  { enqueue, stop }: Pick<VoicePlaybackState, 'enqueue' | 'stop'>,
  { isRunning, messages, enabled }: AutoReadInput
) {
  const stateRef = useRef(INITIAL_AUTO_READ_STATE);
  const messagesRef = useRef(messages);

  const dispatch = useCallback(
    (event: AutoReadEvent) => {
      const { state, toEnqueue } = autoReadStep(stateRef.current, event);
      stateRef.current = state;
      for (const msg of toEnqueue) enqueue({ messageId: msg.id, text: msg.text });
    },
    [enqueue]
  );

  useEffect(() => {
    messagesRef.current = messages;
    dispatch({ type: 'update', isRunning, messages, enabled });
  }, [dispatch, isRunning, messages, enabled]);

  const stopPlayback = useCallback(() => {
    dispatch({ type: 'playbackStopped' });
    stop();
  }, [dispatch, stop]);

  const onPromptSent = useCallback(() => {
    dispatch({ type: 'promptSent', messages: messagesRef.current });
    stop();
  }, [dispatch, stop]);

  return { stopPlayback, onPromptSent };
}
