'use client';

import { useEffect, useState } from 'react';

/**
 * The browser's speech-synthesis voices. Chrome loads them asynchronously, so
 * this starts empty and updates on `voiceschanged`; it stops listening once
 * voices arrive because Firefox re-fires the event on every `getVoices()` call.
 * Empty when the browser has no SpeechSynthesis.
 */
export function useSpeechSynthesisVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const synth = window.speechSynthesis;
    const loadVoices = () => {
      const available = synth.getVoices();
      if (available.length === 0) return;
      synth.removeEventListener('voiceschanged', loadVoices);
      setVoices(available);
    };

    loadVoices();
    synth.addEventListener('voiceschanged', loadVoices);
    return () => {
      synth.removeEventListener('voiceschanged', loadVoices);
    };
  }, []);

  return voices;
}
