'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('auth_token');
}

interface RealtimeToken {
  client_secret: string;
  expires_at: number;
}

async function fetchRealtimeToken(): Promise<RealtimeToken> {
  const token = getAuthToken();
  const response = await fetch('/api/voice/realtime-token', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: 'Failed to get token' }));
    throw new Error(data.error || 'Failed to get realtime token');
  }

  return response.json();
}

/**
 * Hook for streaming voice recording using OpenAI Realtime API.
 *
 * The browser connects directly to OpenAI's Realtime WebSocket using an ephemeral
 * token from our backend. Audio is captured as PCM16 at 24kHz via AudioWorklet
 * and streamed to the WebSocket. Transcription results arrive in real-time.
 */
export function useVoiceRecording() {
  const [isRecording, setIsRecording] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Refs to manage WebSocket and audio resources
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const transcriptRef = useRef('');

  const cleanup = useCallback(() => {
    // Close WebSocket
    if (wsRef.current) {
      if (
        wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING
      ) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }

    // Stop AudioWorklet
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'stop' });
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    // Close AudioContext
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Stop media stream tracks
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const startRecording = useCallback(async () => {
    setError(null);
    setLiveTranscript('');
    transcriptRef.current = '';
    setIsConnecting(true);

    try {
      // Get ephemeral token from our backend
      const { client_secret } = await fetchRealtimeToken();

      // Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // Create AudioContext at 24kHz (required by Realtime API)
      const audioContext = new AudioContext({ sampleRate: 24000 });
      audioContextRef.current = audioContext;

      // Load the PCM16 AudioWorklet processor
      await audioContext.audioWorklet.addModule('/pcm-audio-worklet.js');

      // Connect microphone → AudioWorklet
      const source = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioContext, 'pcm-audio-processor');
      workletNodeRef.current = workletNode;
      source.connect(workletNode);
      // Don't connect to destination — we don't want to play back the mic audio

      // Open WebSocket to OpenAI Realtime API
      const ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', [
        'realtime',
        `openai-insecure-api-key.${client_secret}`,
        'openai-beta.realtime-v1',
      ]);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnecting(false);
        setIsRecording(true);

        // Start forwarding audio data from AudioWorklet to WebSocket
        workletNode.port.onmessage = (event) => {
          if (event.data.type === 'audio' && ws.readyState === WebSocket.OPEN) {
            // Convert ArrayBuffer to base64
            const bytes = new Uint8Array(event.data.buffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            const base64 = btoa(binary);
            ws.send(
              JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: base64,
              })
            );
          }
        };
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);

          if (data.type === 'conversation.item.input_audio_transcription.completed') {
            const text = (data.transcript as string)?.trim();
            if (text) {
              transcriptRef.current = transcriptRef.current
                ? `${transcriptRef.current} ${text}`
                : text;
              setLiveTranscript(transcriptRef.current);
            }
          }

          if (data.type === 'error') {
            console.error('Realtime API error:', data.error);
            if (data.error?.code === 'session_expired') {
              setError('Voice session expired. Please try again.');
              cleanup();
              setIsRecording(false);
              setIsConnecting(false);
            }
          }
        } catch {
          // Ignore unparseable messages
        }
      };

      ws.onerror = () => {
        setError('Voice connection error. Please try again.');
        cleanup();
        setIsRecording(false);
        setIsConnecting(false);
      };

      ws.onclose = () => {
        // Only set states if we didn't already clean up
        if (wsRef.current === ws) {
          setIsRecording(false);
          setIsConnecting(false);
        }
      };
    } catch (err) {
      cleanup();
      setIsConnecting(false);
      setIsRecording(false);

      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setError('Microphone permission denied. Please allow microphone access.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to start recording');
      }
    }
  }, [cleanup]);

  const stopRecording = useCallback((): string => {
    const transcript = transcriptRef.current;
    cleanup();
    setIsRecording(false);
    setIsConnecting(false);
    return transcript;
  }, [cleanup]);

  return {
    isRecording,
    isConnecting,
    liveTranscript,
    startRecording,
    stopRecording,
    error,
  };
}
