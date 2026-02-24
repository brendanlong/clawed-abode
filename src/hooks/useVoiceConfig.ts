'use client';

import { useState, useCallback } from 'react';
import { trpc } from '@/lib/trpc';

const AUTO_READ_KEY_PREFIX = 'voice_auto_read_';

function getStoredAutoRead(sessionId?: string): boolean {
  if (typeof window === 'undefined' || !sessionId) return false;
  return localStorage.getItem(`${AUTO_READ_KEY_PREFIX}${sessionId}`) === 'true';
}

/**
 * Hook for voice configuration state.
 * Queries the server for voice availability and manages auto-read preference in localStorage.
 */
export function useVoiceConfig(sessionId?: string) {
  const { data: config } = trpc.voice.getConfig.useQuery(undefined, {
    staleTime: 60 * 1000,
  });

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
    enabled: config?.enabled ?? false,
    hasAnthropicKey: config?.hasAnthropicKey ?? false,
    autoRead,
    setAutoRead,
  };
}
