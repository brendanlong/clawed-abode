'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

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
 *
 * @param onFinalizedText - Called with each new chunk of finalized (confirmed) text.
 *   Consumers can use this to append text directly to their own state (e.g. a prompt input).
 */
export function useVoiceRecording(onFinalizedText?: (text: string) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const lastFinalizedLengthRef = useRef(0);
  const interimRef = useRef('');
  const onFinalizedTextRef = useRef(onFinalizedText);

  // Keep callback ref fresh without reading it during render
  useEffect(() => {
    onFinalizedTextRef.current = onFinalizedText;
  }, [onFinalizedText]);

  // Cleanup: stop recognition if the component unmounts while recording
  useEffect(() => {
    return () => {
      const recognition = recognitionRef.current;
      if (recognition) {
        recognitionRef.current = null;
        recognition.stop();
      }
    };
  }, []);

  const startRecording = useCallback(() => {
    setError(null);
    setInterimTranscript('');
    lastFinalizedLengthRef.current = 0;
    interimRef.current = '';

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

      // Call back with new finalized text (the delta since last callback)
      if (finals.length > lastFinalizedLengthRef.current) {
        const newText = finals.substring(lastFinalizedLengthRef.current);
        lastFinalizedLengthRef.current = finals.length;
        onFinalizedTextRef.current?.(newText);
      }

      interimRef.current = interim;
      setInterimTranscript(interim);
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
   * Stop recording and return any remaining interim text that wasn't finalized.
   */
  const stopRecording = useCallback((): string => {
    const recognition = recognitionRef.current;
    if (recognition) {
      // Clear ref first so onend handler doesn't auto-restart
      recognitionRef.current = null;
      recognition.stop();
    }
    setIsRecording(false);
    const remaining = interimRef.current;
    interimRef.current = '';
    setInterimTranscript('');
    return remaining;
  }, []);

  return {
    isRecording,
    /** Current interim (not yet confirmed) text, for display hints */
    interimTranscript,
    startRecording,
    stopRecording,
    error,
  };
}
