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

function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
}

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
  // Text accumulated from PREVIOUS recognition sessions (folded in when a
  // session ends). Never touched mid-session.
  const previousSessionsRef = useRef('');
  // Finalized text of the CURRENT recognition session, rebuilt in full from
  // event.results on every onresult. Rebuilding (instead of appending deltas)
  // is what keeps the transcript correct when the browser revises earlier
  // results or delivers cumulative/repeated results (Android Chrome does both).
  const sessionFinalsRef = useRef('');
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
    // Guard against double-invocation (e.g. fast double-tap before React re-renders)
    if (recognitionRef.current) return;

    setError(null);
    setInterimTranscript('');
    previousSessionsRef.current = '';
    sessionFinalsRef.current = '';
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
      // Rebuild the current session's transcript from scratch on every event.
      // event.results is the browser's authoritative, self-consistent view of
      // this session, so overwriting is idempotent: revised, repeated, or
      // cumulative results replace what we had instead of appending garbage.
      // Android Chrome delivers each final result a second time as a duplicate
      // entry with confidence 0; skip those or every utterance appears twice.
      const skipZeroConfidenceFinals = isAndroid();

      let sessionFinals = '';
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          if (skipZeroConfidenceFinals && event.results[i][0].confidence === 0) continue;
          sessionFinals += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      sessionFinalsRef.current = sessionFinals;
      currentInterimRef.current = interim;
      setInterimTranscript(previousSessionsRef.current + sessionFinals + interim);
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
        // Fold the ended session's text (including any interim residual that
        // never finalized) into the cross-session accumulator, then reset the
        // session refs — the new session starts with fresh event.results.
        previousSessionsRef.current += sessionFinalsRef.current + currentInterimRef.current;
        sessionFinalsRef.current = '';
        currentInterimRef.current = '';
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
    const result =
      previousSessionsRef.current + sessionFinalsRef.current + currentInterimRef.current;
    previousSessionsRef.current = '';
    sessionFinalsRef.current = '';
    currentInterimRef.current = '';
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
