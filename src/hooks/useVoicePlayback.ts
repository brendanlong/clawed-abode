'use client';

import { useState, useRef, useCallback, createContext, useContext } from 'react';

function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('auth_token');
}

export interface VoicePlaybackState {
  enabled: boolean;
  isPlaying: boolean;
  currentMessageId: string | null;
  isLoading: boolean;
  play: (messageId: string, text: string) => Promise<void>;
  pause: () => void;
  stop: () => void;
}

const defaultPlaybackState: VoicePlaybackState = {
  enabled: false,
  isPlaying: false,
  currentMessageId: null,
  isLoading: false,
  play: async () => {},
  pause: () => {},
  stop: () => {},
};

export const VoicePlaybackContext = createContext<VoicePlaybackState>(defaultPlaybackState);

export function useVoicePlaybackContext() {
  return useContext(VoicePlaybackContext);
}

/**
 * Hook that manages audio playback state for voice TTS.
 * Handles the text -> TTS -> play pipeline.
 */
export function useVoicePlayback(): VoicePlaybackState {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMessageId, setCurrentMessageId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  const cleanupAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current = null;
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    cleanupAudio();
    setIsPlaying(false);
    setCurrentMessageId(null);
    setIsLoading(false);
  }, [cleanupAudio]);

  const pause = useCallback(() => {
    if (audioRef.current && isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  }, [isPlaying]);

  const play = useCallback(
    async (messageId: string, text: string) => {
      // If we're playing the same message, toggle pause/play
      if (currentMessageId === messageId && audioRef.current) {
        if (isPlaying) {
          audioRef.current.pause();
          setIsPlaying(false);
        } else {
          await audioRef.current.play();
          setIsPlaying(true);
        }
        return;
      }

      // Stop any current playback
      cleanupAudio();

      setIsLoading(true);
      setCurrentMessageId(messageId);
      setIsPlaying(false);

      try {
        const token = getAuthToken();
        const response = await fetch('/api/voice/speak', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ text }),
        });

        if (!response.ok) {
          throw new Error('Speech generation failed');
        }

        const audioBlob = await response.blob();
        const blobUrl = URL.createObjectURL(audioBlob);
        blobUrlRef.current = blobUrl;

        const audio = new Audio(blobUrl);
        audioRef.current = audio;

        audio.onended = () => {
          setIsPlaying(false);
          setCurrentMessageId(null);
          cleanupAudio();
        };

        audio.onerror = () => {
          setIsPlaying(false);
          setCurrentMessageId(null);
          cleanupAudio();
        };

        setIsLoading(false);
        await audio.play();
        setIsPlaying(true);
      } catch {
        setIsLoading(false);
        setIsPlaying(false);
        setCurrentMessageId(null);
        cleanupAudio();
      }
    },
    [currentMessageId, isPlaying, cleanupAudio]
  );

  return {
    enabled: true,
    isPlaying,
    currentMessageId,
    isLoading,
    play,
    pause,
    stop,
  };
}
