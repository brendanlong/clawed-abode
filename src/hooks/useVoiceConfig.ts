'use client';

import { useState, useCallback } from 'react';
import { trpc } from '@/lib/trpc';
import { isSpeechRecognitionSupported } from '@/hooks/useVoiceRecording';

const AUTO_READ_KEY_PREFIX = 'voice_auto_read_';

function getStoredAutoRead(sessionId: string): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(`${AUTO_READ_KEY_PREFIX}${sessionId}`) === 'true';
}

/**
 * Voice configuration: speech input depends on the browser, read-aloud on the
 * server having TTS configured. Auto-read is per session and per device.
 */
export function useVoiceConfig(sessionId: string) {
  const { data: settings } = trpc.globalSettings.get.useQuery(undefined, {
    staleTime: 60 * 1000,
  });

  // The mic is hidden where the browser can't recognize speech.
  const sttEnabled = isSpeechRecognitionSupported();

  const ttsEnabled = settings?.ttsEnabled ?? false;

  const [autoRead, setAutoReadState] = useState(() => getStoredAutoRead(sessionId));

  const setAutoRead = useCallback(
    (value: boolean) => {
      setAutoReadState(value);
      localStorage.setItem(`${AUTO_READ_KEY_PREFIX}${sessionId}`, String(value));
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
