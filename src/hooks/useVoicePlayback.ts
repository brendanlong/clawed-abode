'use client';

import { useState, useRef, useCallback, useEffect, createContext, useContext } from 'react';

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
  restart: () => Promise<void>;
}

const defaultPlaybackState: VoicePlaybackState = {
  enabled: false,
  isPlaying: false,
  currentMessageId: null,
  isLoading: false,
  play: async () => {},
  pause: () => {},
  stop: () => {},
  restart: async () => {},
};

export const VoicePlaybackContext = createContext<VoicePlaybackState>(defaultPlaybackState);

export function useVoicePlaybackContext() {
  return useContext(VoicePlaybackContext);
}

/**
 * Hook that manages audio playback state for voice TTS.
 * Handles the text -> TTS -> play pipeline with per-message blob caching.
 */
export function useVoicePlayback(): VoicePlaybackState {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMessageId, setCurrentMessageId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Cache of messageId -> blob URL, persists until unmount
  const cacheRef = useRef<Map<string, string>>(new Map());

  const stopCurrentAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current = null;
    }
  }, []);

  const cleanupAll = useCallback(() => {
    stopCurrentAudio();
    for (const url of cacheRef.current.values()) {
      URL.revokeObjectURL(url);
    }
    cacheRef.current.clear();
  }, [stopCurrentAudio]);

  const stop = useCallback(() => {
    stopCurrentAudio();
    setIsPlaying(false);
    setCurrentMessageId(null);
    setIsLoading(false);
  }, [stopCurrentAudio]);

  const pause = useCallback(() => {
    if (audioRef.current && isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  }, [isPlaying]);

  const restart = useCallback(async () => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      await audioRef.current.play();
      setIsPlaying(true);
    }
  }, []);

  const playBlobUrl = useCallback((messageId: string, blobUrl: string) => {
    const audio = new Audio(blobUrl);
    audioRef.current = audio;

    audio.onended = () => {
      setIsPlaying(false);
      setCurrentMessageId(null);
      // Don't revoke — keep cached for replay
      audioRef.current = null;
    };

    audio.onerror = () => {
      setIsPlaying(false);
      setCurrentMessageId(null);
      audioRef.current = null;
      // Remove broken cache entry
      const cached = cacheRef.current.get(messageId);
      if (cached) {
        URL.revokeObjectURL(cached);
        cacheRef.current.delete(messageId);
      }
    };

    setCurrentMessageId(messageId);
    return audio.play().then(() => setIsPlaying(true));
  }, []);

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
      stopCurrentAudio();

      // Check cache for this message
      const cached = cacheRef.current.get(messageId);
      if (cached) {
        await playBlobUrl(messageId, cached);
        return;
      }

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
        cacheRef.current.set(messageId, blobUrl);

        setIsLoading(false);
        await playBlobUrl(messageId, blobUrl);
      } catch {
        setIsLoading(false);
        setIsPlaying(false);
        setCurrentMessageId(null);
      }
    },
    [currentMessageId, isPlaying, stopCurrentAudio, playBlobUrl]
  );

  // Clean up all cached blob URLs when the component unmounts
  useEffect(() => {
    return () => cleanupAll();
  }, [cleanupAll]);

  return {
    enabled: true,
    isPlaying,
    currentMessageId,
    isLoading,
    play,
    pause,
    stop,
    restart,
  };
}
