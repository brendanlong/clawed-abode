'use client';

import { useState, useRef, useCallback } from 'react';

function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('auth_token');
}

/**
 * Hook for managing push-to-talk voice recording.
 * Uses MediaRecorder API to capture audio and sends it to the transcription endpoint.
 */
export function useVoiceRecording() {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setError('Microphone permission denied. Please allow microphone access.');
      } else {
        setError('Failed to start recording');
      }
    }
  }, []);

  const stopRecording = useCallback(async (): Promise<string> => {
    return new Promise((resolve, reject) => {
      const mediaRecorder = mediaRecorderRef.current;
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        setIsRecording(false);
        reject(new Error('No active recording'));
        return;
      }

      mediaRecorder.onstop = async () => {
        setIsRecording(false);
        setIsTranscribing(true);

        // Stop all tracks to release the microphone
        mediaRecorder.stream.getTracks().forEach((track) => track.stop());

        try {
          const blob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType });
          chunksRef.current = [];

          // Determine file extension from MIME type
          let ext = 'webm';
          if (mediaRecorder.mimeType.includes('ogg')) ext = 'ogg';
          else if (mediaRecorder.mimeType.includes('mp4')) ext = 'mp4';

          const formData = new FormData();
          formData.append('audio', blob, `recording.${ext}`);

          const token = getAuthToken();
          const response = await fetch('/api/voice/transcribe', {
            method: 'POST',
            headers: token ? { authorization: `Bearer ${token}` } : {},
            body: formData,
          });

          if (!response.ok) {
            const data = await response.json().catch(() => ({ error: 'Transcription failed' }));
            throw new Error(data.error || 'Transcription failed');
          }

          const data = await response.json();
          setIsTranscribing(false);
          resolve(data.text);
        } catch (err) {
          setIsTranscribing(false);
          const message = err instanceof Error ? err.message : 'Transcription failed';
          setError(message);
          reject(err);
        }
      };

      mediaRecorder.stop();
    });
  }, []);

  return {
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
    error,
  };
}
