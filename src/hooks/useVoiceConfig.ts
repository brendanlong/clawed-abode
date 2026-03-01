'use client';

import { useState, useCallback, useMemo } from 'react';
import { trpc } from '@/lib/trpc';

const AUTO_READ_KEY_PREFIX = 'voice_auto_read_';
const VOICE_URI_KEY = 'tts_voice_uri';

function getStoredAutoRead(sessionId?: string): boolean {
  if (typeof window === 'undefined' || !sessionId) return false;
  return localStorage.getItem(`${AUTO_READ_KEY_PREFIX}${sessionId}`) === 'true';
}

function getStoredVoiceURI(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(VOICE_URI_KEY);
}

/**
 * Hook for voice configuration state.
 * Voice is available based on browser Web Speech API support (no server API key needed).
 * Still queries the server for voiceAutoSend and ttsSpeed settings.
 * Voice selection is stored in localStorage (per-device, since available voices differ).
 */
export function useVoiceConfig(sessionId?: string) {
  const { data: settings } = trpc.globalSettings.get.useQuery(undefined, {
    staleTime: 60 * 1000,
  });

  const sttEnabled = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
  }, []);

  const ttsEnabled = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return 'speechSynthesis' in window;
  }, []);

  const [autoRead, setAutoReadState] = useState(() => getStoredAutoRead(sessionId));

  const setAutoRead = useCallback(
    (value: boolean) => {
      setAutoReadState(value);
      if (typeof window !== 'undefined' && sessionId) {
        localStorage.setItem(`${AUTO_READ_KEY_PREFIX}${sessionId}`, String(value));
      }
    },
    [sessionId]
  );

  const [voiceURI, setVoiceURIState] = useState<string | null>(() => getStoredVoiceURI());

  const setVoiceURI = useCallback((uri: string | null) => {
    setVoiceURIState(uri);
    if (typeof window !== 'undefined') {
      if (uri) {
        localStorage.setItem(VOICE_URI_KEY, uri);
      } else {
        localStorage.removeItem(VOICE_URI_KEY);
      }
    }
  }, []);

  return {
    enabled: sttEnabled || ttsEnabled,
    sttEnabled,
    ttsEnabled,
    autoRead,
    setAutoRead,
    autoSend: settings?.voiceAutoSend ?? true,
    ttsSpeed: settings?.ttsSpeed ?? 1.0,
    voiceURI,
    setVoiceURI,
  };
}
