'use client';

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  createContext,
  useContext,
  useMemo,
} from 'react';
import { isMSESupported, StreamingAudioPlayer } from '@/lib/streaming-audio-player';
import { startTTSStream, TTSStreamHandle } from '@/lib/tts-stream-client';

function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('auth_token');
}

/** Item in the sequential playback queue */
export interface PlaybackQueueItem {
  messageId: string;
  text: string;
}

export interface VoicePlaybackState {
  enabled: boolean;
  isPlaying: boolean;
  currentMessageId: string | null;
  isLoading: boolean;
  play: (messageId: string, text: string) => Promise<void>;
  playSequential: (items: PlaybackQueueItem[]) => void;
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
  playSequential: () => {},
  pause: () => {},
  stop: () => {},
  restart: async () => {},
};

export const VoicePlaybackContext = createContext<VoicePlaybackState>(defaultPlaybackState);

export function useVoicePlaybackContext() {
  return useContext(VoicePlaybackContext);
}

/** Cached AAC chunks for a message, indexed by chunk number. */
interface CachedAudio {
  chunks: Uint8Array[];
}

/**
 * Hook that manages audio playback state for voice TTS.
 *
 * When MSE is supported (most desktop browsers, Android Chrome), uses streaming
 * playback via /api/voice/speak-stream SSE endpoint for low-latency first audio.
 *
 * When MSE is not supported (iPhone Safari), falls back to the existing
 * blob-based approach via /api/voice/speak.
 */
export function useVoicePlayback(): VoicePlaybackState {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMessageId, setCurrentMessageId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // MSE streaming refs
  const streamHandleRef = useRef<TTSStreamHandle | null>(null);
  const playerRef = useRef<StreamingAudioPlayer | null>(null);
  // Cache: messageId -> raw AAC chunks
  const mseCacheRef = useRef<Map<string, CachedAudio>>(new Map());

  // Legacy blob refs (fallback for non-MSE browsers)
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobCacheRef = useRef<Map<string, string>>(new Map());

  // Sequential playback queue: remaining items to play after current finishes
  const queueRef = useRef<PlaybackQueueItem[]>([]);
  // Ref to the "play next from queue" function, set after playInternal is defined
  const playNextFromQueueRef = useRef<() => void>(() => {});

  const mseSupported = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return isMSESupported();
  }, []);

  // --- Shared cleanup helpers ---

  const stopStreamPlayback = useCallback(() => {
    if (streamHandleRef.current) {
      streamHandleRef.current.abort();
      streamHandleRef.current = null;
    }
    if (playerRef.current) {
      playerRef.current.destroy();
      playerRef.current = null;
    }
  }, []);

  const stopLegacyPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current = null;
    }
  }, []);

  const stopCurrentAudio = useCallback(() => {
    stopStreamPlayback();
    stopLegacyPlayback();
  }, [stopStreamPlayback, stopLegacyPlayback]);

  const cleanupAll = useCallback(() => {
    stopCurrentAudio();
    queueRef.current = [];
    // Revoke blob URLs
    for (const url of blobCacheRef.current.values()) {
      URL.revokeObjectURL(url);
    }
    blobCacheRef.current.clear();
    mseCacheRef.current.clear();
  }, [stopCurrentAudio]);

  const stop = useCallback(() => {
    queueRef.current = [];
    stopCurrentAudio();
    setIsPlaying(false);
    setCurrentMessageId(null);
    setIsLoading(false);
  }, [stopCurrentAudio]);

  const pause = useCallback(() => {
    if (isPlaying) {
      if (playerRef.current) {
        playerRef.current.pause();
      } else if (audioRef.current) {
        audioRef.current.pause();
      }
      setIsPlaying(false);
    }
  }, [isPlaying]);

  const restart = useCallback(async () => {
    if (playerRef.current) {
      playerRef.current.restart();
      setIsPlaying(true);
    } else if (audioRef.current) {
      audioRef.current.currentTime = 0;
      await audioRef.current.play();
      setIsPlaying(true);
    }
  }, []);

  // --- Legacy blob playback (iPhone Safari fallback) ---

  const playBlobUrl = useCallback((messageId: string, blobUrl: string) => {
    const audio = new Audio(blobUrl);
    audioRef.current = audio;

    audio.onended = () => {
      audioRef.current = null;
      playNextFromQueueRef.current();
    };

    audio.onerror = () => {
      queueRef.current = [];
      setIsPlaying(false);
      setCurrentMessageId(null);
      audioRef.current = null;
      const cached = blobCacheRef.current.get(messageId);
      if (cached) {
        URL.revokeObjectURL(cached);
        blobCacheRef.current.delete(messageId);
      }
    };

    setCurrentMessageId(messageId);
    return audio.play().then(() => setIsPlaying(true));
  }, []);

  const playLegacy = useCallback(
    async (messageId: string, text: string) => {
      // Check blob cache
      const cached = blobCacheRef.current.get(messageId);
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
        blobCacheRef.current.set(messageId, blobUrl);

        setIsLoading(false);
        await playBlobUrl(messageId, blobUrl);
      } catch {
        queueRef.current = [];
        setIsLoading(false);
        setIsPlaying(false);
        setCurrentMessageId(null);
      }
    },
    [playBlobUrl]
  );

  // --- MSE streaming playback ---

  const playCachedMSE = useCallback((messageId: string, cached: CachedAudio) => {
    // Replay cached AAC chunks through a fresh player
    const player = new StreamingAudioPlayer({
      onPlaying: () => setIsPlaying(true),
      onEnded: () => {
        playerRef.current = null;
        playNextFromQueueRef.current();
      },
      onError: () => {
        queueRef.current = [];
        setIsPlaying(false);
        setCurrentMessageId(null);
        playerRef.current = null;
        mseCacheRef.current.delete(messageId);
      },
    });
    playerRef.current = player;
    setCurrentMessageId(messageId);

    // Feed all cached chunks synchronously, then finalize
    (async () => {
      for (const chunk of cached.chunks) {
        await player.appendChunk(chunk);
      }
      await player.finalize();
    })().catch(() => {
      setIsPlaying(false);
      setCurrentMessageId(null);
    });
  }, []);

  const playStreaming = useCallback((messageId: string, text: string) => {
    setIsLoading(true);
    setCurrentMessageId(messageId);
    setIsPlaying(false);

    const collectedChunks: Uint8Array[] = [];

    const handle = startTTSStream({
      text,
      token: getAuthToken(),
      onChunk: (_index, aacData) => {
        collectedChunks.push(aacData);
      },
      playerCallbacks: {
        onPlaying: () => {
          setIsLoading(false);
          setIsPlaying(true);
        },
        onEnded: () => {
          streamHandleRef.current = null;
          playerRef.current = null;
          playNextFromQueueRef.current();
        },
        onError: () => {
          queueRef.current = [];
          setIsPlaying(false);
          setIsLoading(false);
          setCurrentMessageId(null);
          streamHandleRef.current = null;
          playerRef.current = null;
          // Discard partial cache
          mseCacheRef.current.delete(messageId);
        },
      },
    });

    streamHandleRef.current = handle;
    playerRef.current = handle.player;

    // When the stream finishes, save collected chunks to cache
    handle.done
      .then(() => {
        if (collectedChunks.length > 0) {
          mseCacheRef.current.set(messageId, { chunks: collectedChunks });
        }
      })
      .catch(() => {
        // Stream was aborted or errored — partial cache already discarded
      });
  }, []);

  // --- Internal play (no toggle logic, used by play and playSequential) ---

  const playInternal = useCallback(
    async (messageId: string, text: string) => {
      stopCurrentAudio();

      if (mseSupported) {
        const cached = mseCacheRef.current.get(messageId);
        if (cached) {
          playCachedMSE(messageId, cached);
          return;
        }
        playStreaming(messageId, text);
      } else {
        await playLegacy(messageId, text);
      }
    },
    [stopCurrentAudio, mseSupported, playCachedMSE, playStreaming, playLegacy]
  );

  // Wire up the playNextFromQueue ref — called by onEnded callbacks
  useEffect(() => {
    playNextFromQueueRef.current = () => {
      const next = queueRef.current.shift();
      if (next) {
        playInternal(next.messageId, next.text);
      } else {
        // Queue exhausted, reset state
        setIsPlaying(false);
        setCurrentMessageId(null);
      }
    };
  }, [playInternal]);

  // --- Main play function ---

  const play = useCallback(
    async (messageId: string, text: string) => {
      // Clear any pending queue when user manually plays a message
      queueRef.current = [];

      // If we're playing the same message, toggle pause/play
      if (currentMessageId === messageId) {
        if (isPlaying) {
          if (playerRef.current) {
            playerRef.current.pause();
          } else if (audioRef.current) {
            audioRef.current.pause();
          }
          setIsPlaying(false);
        } else {
          if (playerRef.current) {
            playerRef.current.resume();
            setIsPlaying(true);
          } else if (audioRef.current) {
            await audioRef.current.play();
            setIsPlaying(true);
          }
        }
        return;
      }

      await playInternal(messageId, text);
    },
    [currentMessageId, isPlaying, playInternal]
  );

  // --- Sequential playback (auto-read) ---

  const playSequential = useCallback(
    (items: PlaybackQueueItem[]) => {
      if (items.length === 0) return;

      // Clear any existing queue and stop current playback
      queueRef.current = [];
      stopCurrentAudio();

      // Set up queue with remaining items (all after the first)
      queueRef.current = items.slice(1);

      // Start playing the first item
      playInternal(items[0].messageId, items[0].text);
    },
    [stopCurrentAudio, playInternal]
  );

  // Clean up on unmount
  useEffect(() => {
    return () => cleanupAll();
  }, [cleanupAll]);

  return {
    enabled: true,
    isPlaying,
    currentMessageId,
    isLoading,
    play,
    playSequential,
    pause,
    stop,
    restart,
  };
}
