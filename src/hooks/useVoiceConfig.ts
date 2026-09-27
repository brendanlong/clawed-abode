'use client';

import { useState, useCallback, useMemo } from 'react';
import { trpc } from '@/lib/trpc';

const AUTO_READ_KEY_PREFIX = 'voice_auto_read_';

function getStoredAutoRead(sessionId?: string): boolean {
  if (typeof window === 'undefined' || !sessionId) return false;
  return localStorage.getItem(`${AUTO_READ_KEY_PREFIX}${sessionId}`) === 'true';
}

/**
 * Voice configuration: speech input depends on the browser, read-aloud on the
 * server having TTS configured. Auto-read is per session and per device.
 */
export function useVoiceConfig(sessionId?: string) {
  const { data: settings } = trpc.globalSettings.get.useQuery(undefined, {
    staleTime: 60 * 1000,
  });

  // Firefox ships no SpeechRecognition (behind a flag), so the mic is hidden there.
  const sttEnabled = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
  }, []);

  const ttsEnabled = settings?.ttsEnabled ?? false;

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

  return {
    enabled: sttEnabled || ttsEnabled,
    sttEnabled,
    ttsEnabled,
    autoRead,
    setAutoRead,
    autoSend: settings?.voiceAutoSend ?? true,
  };
}
