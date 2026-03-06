'use client';

import { useState, useRef, useCallback } from 'react';

// Web Speech API types (not in all TS libs)
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as unknown as Record<string, SpeechRecognitionConstructor>).SpeechRecognition ??
    (window as unknown as Record<string, SpeechRecognitionConstructor>).webkitSpeechRecognition ??
    null
  );
}

/**
 * Hook for managing voice recording using the Web Speech API (SpeechRecognition).
 * Uses continuous mode to keep listening through pauses in speech.
 * Accumulates all recognized text and exposes a live-updating transcript.
 */
export function useVoiceRecording() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const transcriptRef = useRef('');

  const startRecording = useCallback(() => {
    setError(null);
    setTranscript('');
    transcriptRef.current = '';

    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      setError('Speech recognition is not supported in this browser.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognitionRef.current = recognition;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finals = '';
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finals += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      const full = (finals + interim).trimStart();
      transcriptRef.current = full;
      setTranscript(full);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // 'no-speech' and 'aborted' are not real errors
      if (event.error === 'no-speech' || event.error === 'aborted') {
        return;
      }
      const message =
        event.error === 'not-allowed'
          ? 'Microphone permission denied. Please allow microphone access.'
          : `Speech recognition error: ${event.error}`;
      setError(message);
    };

    recognition.onend = () => {
      // If the recognition ended but we still hold a reference to it,
      // the browser stopped unexpectedly (e.g. silence timeout in some browsers).
      // Auto-restart to maintain continuous recording.
      if (recognitionRef.current === recognition) {
        try {
          recognition.start();
        } catch {
          // Can't restart — mark as stopped
          setIsRecording(false);
          recognitionRef.current = null;
        }
      }
    };

    try {
      recognition.start();
      setIsRecording(true);
    } catch {
      setError('Failed to start speech recognition');
    }
  }, []);

  /**
   * Stop recording and return the current transcript (including any interim text).
   */
  const stopRecording = useCallback((): string => {
    const recognition = recognitionRef.current;
    if (recognition) {
      // Clear ref first so onend handler doesn't auto-restart
      recognitionRef.current = null;
      recognition.stop();
    }
    setIsRecording(false);
    return transcriptRef.current;
  }, []);

  return {
    isRecording,
    /** Live-updating transcript: accumulated final results + current interim */
    transcript,
    startRecording,
    stopRecording,
    error,
  };
}
