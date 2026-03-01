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
 * Provides real-time transcription in the browser with no server round-trip.
 */
export function useVoiceRecording() {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const resolveRef = useRef<((text: string) => void) | null>(null);
  const rejectRef = useRef<((err: Error) => void) | null>(null);

  const startRecording = useCallback(async () => {
    setError(null);
    setInterimTranscript(null);

    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      setError('Speech recognition is not supported in this browser.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognitionRef.current = recognition;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      if (interim) {
        setInterimTranscript(interim);
      }
      if (final) {
        setInterimTranscript(null);
        resolveRef.current?.(final);
        resolveRef.current = null;
        rejectRef.current = null;
      }
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
      rejectRef.current?.(new Error(message));
      resolveRef.current = null;
      rejectRef.current = null;
    };

    recognition.onend = () => {
      setIsRecording(false);
      setIsTranscribing(false);
      setInterimTranscript(null);
      // If we haven't resolved yet (e.g. no speech detected), resolve with empty string
      if (resolveRef.current) {
        resolveRef.current('');
        resolveRef.current = null;
        rejectRef.current = null;
      }
    };

    try {
      recognition.start();
      setIsRecording(true);
    } catch {
      setError('Failed to start speech recognition');
    }
  }, []);

  const stopRecording = useCallback(async (): Promise<string> => {
    return new Promise((resolve, reject) => {
      const recognition = recognitionRef.current;
      if (!recognition) {
        setIsRecording(false);
        reject(new Error('No active recording'));
        return;
      }

      resolveRef.current = (text: string) => {
        setIsTranscribing(false);
        resolve(text);
      };
      rejectRef.current = (err: Error) => {
        setIsTranscribing(false);
        reject(err);
      };

      setIsTranscribing(true);
      recognition.stop();
    });
  }, []);

  return {
    isRecording,
    isTranscribing,
    interimTranscript,
    startRecording,
    stopRecording,
    error,
  };
}
