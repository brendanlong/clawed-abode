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
 * The hook tracks the full accumulated transcript internally (across recognition
 * session restarts) and exposes it via `interimTranscript` for display.
 * When recording stops, `stopRecording()` returns the full transcript.
 */
export function useVoiceRecording() {
  const [isRecording, setIsRecording] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  // Accumulated finalized text across all recognition sessions
  const accumulatedFinalsRef = useRef('');
  // Tracks finalized text length within the CURRENT recognition session only.
  // Reset to 0 on each auto-restart so the fresh event.results is handled correctly.
  const sessionFinalsLengthRef = useRef(0);
  // Current interim text (for returning residual when stopped)
  const currentInterimRef = useRef('');

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
    accumulatedFinalsRef.current = '';
    sessionFinalsLengthRef.current = 0;
    currentInterimRef.current = '';

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
      let sessionFinals = '';
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          sessionFinals += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      // Detect new finalized text within this recognition session
      if (sessionFinals.length > sessionFinalsLengthRef.current) {
        const delta = sessionFinals.substring(sessionFinalsLengthRef.current);
        sessionFinalsLengthRef.current = sessionFinals.length;
        accumulatedFinalsRef.current += delta;
      }

      currentInterimRef.current = interim;
      // Expose the full transcript: all accumulated finals + current interim
      setInterimTranscript(accumulatedFinalsRef.current + interim);
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
        // Reset session-level tracking since the new session starts with fresh results
        sessionFinalsLengthRef.current = 0;
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
   * Stop recording and return the full accumulated transcript
   * (all finalized text + any remaining interim text).
   */
  const stopRecording = useCallback((): string => {
    const recognition = recognitionRef.current;
    if (recognition) {
      // Clear ref first so onend handler doesn't auto-restart
      recognitionRef.current = null;
      recognition.stop();
    }
    setIsRecording(false);
    const result = accumulatedFinalsRef.current + currentInterimRef.current;
    accumulatedFinalsRef.current = '';
    currentInterimRef.current = '';
    sessionFinalsLengthRef.current = 0;
    setInterimTranscript('');
    return result;
  }, []);

  return {
    isRecording,
    /** Full accumulated transcript (finalized + current interim), for display */
    interimTranscript,
    startRecording,
    stopRecording,
    error,
  };
}
