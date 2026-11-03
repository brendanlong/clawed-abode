'use client';

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  createContext,
  useContext,
  createElement,
  type ReactNode,
} from 'react';
import { z } from 'zod';
import { getAuthToken } from '@/lib/auth-token';
import { PCM_SAMPLE_RATE, pcm16ToFloat32 } from '@/lib/pcm';
import { loadSpeechEncoder, type SpeechEncoder } from '@/lib/speech-encoding';
import {
  getMediaSourceClass,
  IDLE_SPEECH_STATE,
  SpeechPlayer,
  UNSUPPORTED_MESSAGE,
  type SpeechAudio,
  type SpeechItem,
  type SpeechPlayerState,
} from '@/lib/speech-player';

export interface VoicePlaybackState extends SpeechPlayerState {
  enabled: boolean;
  play: (messageId: string, text: string) => void;
  enqueue: (item: SpeechItem) => void;
  pause: () => void;
  stop: () => void;
  restart: () => void;
  /** Route OS media-control Stop through `handler` instead of a plain stop (null to reset). */
  setStopHandler: (handler: (() => void) | null) => void;
}

export const defaultPlaybackState: VoicePlaybackState = {
  ...IDLE_SPEECH_STATE,
  enabled: false,
  play: () => {},
  enqueue: () => {},
  pause: () => {},
  stop: () => {},
  restart: () => {},
  setStopHandler: () => {},
};

const VoicePlaybackContext = createContext<VoicePlaybackState>(defaultPlaybackState);
const VoicePlaybackEnabledContext = createContext(false);

/**
 * Provides playback, plus whether it is enabled as a context of its own: the
 * playback state changes as audio plays, and every message bubble needs only
 * `enabled`, so bubbles don't re-render with it. Memoize `value`; a new object
 * re-renders every reader.
 */
export function VoicePlaybackProvider({
  value,
  children,
}: {
  value: VoicePlaybackState;
  children: ReactNode;
}) {
  return createElement(
    VoicePlaybackEnabledContext.Provider,
    { value: value.enabled },
    createElement(VoicePlaybackContext.Provider, { value }, children)
  );
}

/** The whole playback state; re-renders the caller whenever playback changes. */
export function useVoicePlaybackContext() {
  return useContext(VoicePlaybackContext);
}

/** Whether read-aloud is available; stable while audio plays. */
export function useVoicePlaybackEnabled(): boolean {
  return useContext(VoicePlaybackEnabledContext);
}

const speechErrorSchema = z.object({ error: z.string() });

let encoder: Promise<SpeechEncoder | null> | null = null;

/** Loaded once per page, on first use; a failure is retried next time. */
function getEncoder(mediaSource: typeof MediaSource): Promise<SpeechEncoder | null> {
  encoder ??= loadSpeechEncoder(mediaSource, PCM_SAMPLE_RATE).catch((err: unknown) => {
    encoder = null;
    throw err;
  });
  return encoder;
}

/** A response body's pieces; cancels the body if the reader stops early. */
async function* readBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!done) void reader.cancel().catch(() => {});
  }
}

/**
 * Ask the server to speak `text`. It streams raw PCM, which is encoded here as
 * it arrives (the encoder loads while the server starts synthesizing).
 */
async function openSpeech(text: string, signal: AbortSignal): Promise<SpeechAudio> {
  const mediaSource = getMediaSourceClass();
  if (!mediaSource) throw new Error(UNSUPPORTED_MESSAGE);
  // Null if it failed to load too (retried next time).
  const loading = getEncoder(mediaSource).catch(() => null);

  const token = getAuthToken();
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = speechErrorSchema.safeParse(await res.json().catch(() => null));
    throw new Error(body.success ? body.data.error : `Speech request failed (${res.status})`);
  }
  const loaded = await loading;
  if (!loaded) {
    void res.body.cancel().catch(() => {});
    throw new Error(UNSUPPORTED_MESSAGE);
  }
  return {
    mimeType: loaded.mimeType,
    pieces: loaded.encode(pcm16ToFloat32(readBody(res.body)), PCM_SAMPLE_RATE),
  };
}

const MEDIA_TITLE_LENGTH = 80;

function setMediaMetadata(item: SpeechItem | null): void {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = item
    ? new MediaMetadata({
        title: item.text.replace(/\s+/g, ' ').slice(0, MEDIA_TITLE_LENGTH),
        artist: 'Claude',
        artwork: [{ src: '/favicon-512x512.png', sizes: '512x512', type: 'image/png' }],
      })
    : null;
}

/**
 * Read-aloud through the server's Kokoro TTS (see SpeechPlayer), wired to the
 * OS media controls. `enabled` is false when the server has no TTS configured.
 * `autoRead` makes taps prime the player for unprompted playback; it's off
 * otherwise because on iOS even silent playback pauses other apps' audio.
 */
export function useVoicePlayback(enabled: boolean, autoRead = false): VoicePlaybackState {
  const [state, setState] = useState<SpeechPlayerState>(IDLE_SPEECH_STATE);
  const playerRef = useRef<SpeechPlayer | null>(null);
  const stopHandlerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const player = new SpeechPlayer(new Audio(), openSpeech, setState);
    playerRef.current = player;

    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => player.resume()],
      ['pause', () => player.pause()],
      ['stop', () => (stopHandlerRef.current ? stopHandlerRef.current() : player.stop())],
      ['nexttrack', () => player.next()],
      ['previoustrack', () => player.restart()],
    ];
    const mediaSession = 'mediaSession' in navigator ? navigator.mediaSession : null;
    for (const [action, handler] of handlers) mediaSession?.setActionHandler(action, handler);

    return () => {
      for (const [action] of handlers) mediaSession?.setActionHandler(action, null);
      setMediaMetadata(null);
      player.destroy();
      playerRef.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    const player = playerRef.current;
    if (!enabled || !autoRead || !player) return;
    const prime = () => player.prime();
    document.addEventListener('pointerdown', prime, { capture: true });
    return () => document.removeEventListener('pointerdown', prime, { capture: true });
  }, [enabled, autoRead]);

  useEffect(() => {
    setMediaMetadata(playerRef.current?.currentItem ?? null);
  }, [state.currentMessageId]);

  const play = useCallback((messageId: string, text: string) => {
    playerRef.current?.play({ messageId, text });
  }, []);
  const enqueue = useCallback((item: SpeechItem) => playerRef.current?.enqueue(item), []);
  const pause = useCallback(() => playerRef.current?.pause(), []);
  const stop = useCallback(() => playerRef.current?.stop(), []);
  const restart = useCallback(() => playerRef.current?.restart(), []);
  const setStopHandler = useCallback((handler: (() => void) | null) => {
    stopHandlerRef.current = handler;
  }, []);

  return useMemo(
    () => ({ ...state, enabled, play, enqueue, pause, stop, restart, setStopHandler }),
    [state, enabled, play, enqueue, pause, stop, restart, setStopHandler]
  );
}
