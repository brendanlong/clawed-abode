'use client';

import { useState, useRef, useCallback, useEffect, createContext, useContext } from 'react';
import { z } from 'zod';
import { getAuthToken } from '@/lib/auth-token';
import {
  IDLE_SPEECH_STATE,
  SpeechPlayer,
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
}

export const defaultPlaybackState: VoicePlaybackState = {
  ...IDLE_SPEECH_STATE,
  enabled: false,
  play: () => {},
  enqueue: () => {},
  pause: () => {},
  stop: () => {},
  restart: () => {},
};

export const VoicePlaybackContext = createContext<VoicePlaybackState>(defaultPlaybackState);

export function useVoicePlaybackContext() {
  return useContext(VoicePlaybackContext);
}

const speechResponseSchema = z.union([
  z.object({ url: z.string() }),
  z.object({ error: z.string() }),
]);

/** Ask the server to synthesize `text`; resolves to the URL its audio streams from. */
async function requestSpeechUrl(text: string, signal?: AbortSignal): Promise<string> {
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
  const body = speechResponseSchema.safeParse(await res.json().catch(() => null));
  if (res.ok && body.success && 'url' in body.data) return body.data.url;
  throw new Error(
    body.success && 'error' in body.data ? body.data.error : `Speech request failed (${res.status})`
  );
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

  useEffect(() => {
    if (!enabled) return;
    const player = new SpeechPlayer(new Audio(), requestSpeechUrl, setState);
    playerRef.current = player;

    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => player.resume()],
      ['pause', () => player.pause()],
      ['stop', () => player.stop()],
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

  return { ...state, enabled, play, enqueue, pause, stop, restart };
}
