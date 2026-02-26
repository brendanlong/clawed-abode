'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { X, Mic, Square, Play, Pause, SkipBack, SkipForward, Send, Loader2 } from 'lucide-react';
import { useVoicePlaybackContext } from '@/hooks/useVoicePlayback';
import { useVoiceRecording } from '@/hooks/useVoiceRecording';
import { useVoiceConfig } from '@/hooks/useVoiceConfig';
import { extractAssistantText } from '@/lib/auto-read-helpers';
import { cn } from '@/lib/utils';

/** Minimal message shape passed into the overlay */
interface OverlayMessage {
  id: string;
  type: string;
  content: unknown;
  sequence: number;
}

interface VoiceOverlayProps {
  sessionId: string;
  messages: OverlayMessage[];
  isClaudeRunning: boolean;
  onSendPrompt: (prompt: string) => void;
  onClose: () => void;
}

/** An assistant message with extractable text, for prev/next navigation */
interface AssistantTextEntry {
  id: string;
  text: string;
}

/**
 * Build a list of assistant messages that have meaningful text content.
 * Used for prev/next navigation in the overlay.
 */
function getAssistantTextMessages(messages: OverlayMessage[]): AssistantTextEntry[] {
  const results: AssistantTextEntry[] = [];
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    if (msg.id.startsWith('partial-')) continue;
    const text = extractAssistantText(msg);
    if (text !== null) {
      results.push({ id: msg.id, text });
    }
  }
  return results;
}

/**
 * Full-screen voice overlay for hands-free interaction with Claude.
 * Large touch targets, high contrast, designed for mobile use.
 */
export function VoiceOverlay({
  sessionId,
  messages,
  isClaudeRunning,
  onSendPrompt,
  onClose,
}: VoiceOverlayProps) {
  const playback = useVoicePlaybackContext();
  const {
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
    error: recordingError,
  } = useVoiceRecording();
  const voiceConfig = useVoiceConfig(sessionId);

  // Transcript from the last recording, before user decides to send or cancel
  const [transcript, setTranscript] = useState<string | null>(null);

  // Wake Lock to keep screen awake while overlay is open
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    let active = true;
    async function acquireWakeLock() {
      if ('wakeLock' in navigator) {
        try {
          const lock = await navigator.wakeLock.request('screen');
          if (active) {
            wakeLockRef.current = lock;
          } else {
            lock.release();
          }
        } catch {
          // Wake Lock API may not be available or user may have denied
        }
      }
    }
    acquireWakeLock();

    // Re-acquire on visibility change (wake lock is released when tab is hidden)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && active) {
        acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    };
  }, []);

  // Build list of assistant text messages for navigation
  const assistantTextMessages = useMemo(() => getAssistantTextMessages(messages), [messages]);

  // Find the index of the currently playing message in the assistant text list
  const currentIndex = useMemo(() => {
    if (!playback.currentMessageId) return -1;
    return assistantTextMessages.findIndex((m) => m.id === playback.currentMessageId);
  }, [playback.currentMessageId, assistantTextMessages]);

  // Get the text of the currently playing message
  const currentDisplayText = useMemo(() => {
    if (currentIndex >= 0) {
      return assistantTextMessages[currentIndex].text;
    }
    return null;
  }, [currentIndex, assistantTextMessages]);

  // Navigation: play previous assistant text message
  const handlePrev = useCallback(() => {
    if (currentIndex <= 0) return;
    const targetIndex = currentIndex - 1;
    const target = assistantTextMessages[targetIndex];
    if (target) {
      playback.play(target.id, target.text);
    }
  }, [currentIndex, assistantTextMessages, playback]);

  // Navigation: play next assistant text message
  const handleNext = useCallback(() => {
    const targetIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    if (targetIndex < assistantTextMessages.length) {
      const entry = assistantTextMessages[targetIndex];
      playback.play(entry.id, entry.text);
    }
  }, [currentIndex, assistantTextMessages, playback]);

  // Play/pause toggle
  const handlePlayPause = useCallback(() => {
    if (playback.isPlaying) {
      playback.pause();
    } else if (playback.currentMessageId) {
      // Resume the current message
      const entry = assistantTextMessages.find((m) => m.id === playback.currentMessageId);
      if (entry) {
        playback.play(entry.id, entry.text);
      }
    } else if (assistantTextMessages.length > 0) {
      // Nothing playing, start the last message
      const last = assistantTextMessages[assistantTextMessages.length - 1];
      playback.play(last.id, last.text);
    }
  }, [playback, assistantTextMessages]);

  // Recording: start or stop
  const handleMicPress = useCallback(async () => {
    if (isRecording) {
      try {
        const text = await stopRecording();
        if (text.trim()) {
          if (voiceConfig.autoRead) {
            // Auto-send mode: send immediately without showing transcript
            onSendPrompt(text.trim());
          } else {
            setTranscript(text.trim());
          }
        }
      } catch {
        // Error handled by hook
      }
    } else {
      setTranscript(null);
      await startRecording();
    }
  }, [isRecording, startRecording, stopRecording, voiceConfig.autoRead, onSendPrompt]);

  // Send the transcript
  const handleSend = useCallback(() => {
    if (transcript) {
      onSendPrompt(transcript);
      setTranscript(null);
    }
  }, [transcript, onSendPrompt]);

  // Cancel the transcript
  const handleCancel = useCallback(() => {
    setTranscript(null);
  }, []);

  // Determine status text when not playing
  const statusText = useMemo(() => {
    if (isRecording) return 'Listening...';
    if (isTranscribing) return 'Transcribing...';
    if (isClaudeRunning) return 'Waiting for Claude...';
    if (transcript) return 'Review transcript below';
    return 'Ready';
  }, [isRecording, isTranscribing, isClaudeRunning, transcript]);

  const hasPrev = assistantTextMessages.length > 0 && currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < assistantTextMessages.length - 1;
  const hasPlayableContent = assistantTextMessages.length > 0;

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      {/* Close button */}
      <div className="flex justify-end p-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-12 w-12"
          title="Close voice overlay"
        >
          <X className="h-6 w-6" />
        </Button>
      </div>

      {/* Message display / status area */}
      <div className="flex-1 min-h-0 px-6 pb-4">
        <ScrollArea className="h-full">
          {currentDisplayText ? (
            <p className="text-lg leading-relaxed text-foreground whitespace-pre-wrap">
              {currentDisplayText}
            </p>
          ) : transcript ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Your message:</p>
              <p className="text-lg leading-relaxed text-foreground">{transcript}</p>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                {isClaudeRunning || isTranscribing ? (
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mx-auto mb-4" />
                ) : null}
                <p className="text-xl text-muted-foreground">{statusText}</p>
              </div>
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Playback controls row */}
      <div className="border-t px-6 py-4">
        <div className="flex items-center justify-center gap-4">
          <Button
            variant="outline"
            size="icon"
            className="h-16 w-16 rounded-full"
            onClick={handlePrev}
            disabled={!hasPrev}
            title="Previous message"
          >
            <SkipBack className="h-6 w-6" />
          </Button>

          <Button
            variant={playback.isPlaying ? 'secondary' : 'default'}
            size="icon"
            className="h-16 w-16 rounded-full"
            onClick={handlePlayPause}
            disabled={!hasPlayableContent && !playback.isPlaying}
            title={playback.isPlaying ? 'Pause' : 'Play'}
          >
            {playback.isLoading ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : playback.isPlaying ? (
              <Pause className="h-6 w-6" />
            ) : (
              <Play className="h-6 w-6" />
            )}
          </Button>

          <Button
            variant="outline"
            size="icon"
            className="h-16 w-16 rounded-full"
            onClick={handleNext}
            disabled={!hasNext}
            title="Next message"
          >
            <SkipForward className="h-6 w-6" />
          </Button>

          <Button
            variant="outline"
            size="icon"
            className="h-16 w-16 rounded-full"
            onClick={playback.stop}
            disabled={!playback.currentMessageId}
            title="Stop"
          >
            <Square className="h-6 w-6" />
          </Button>
        </div>
      </div>

      {/* Record area + send/cancel */}
      <div className="border-t px-6 py-6 pb-8">
        {/* Large mic button */}
        <div className="flex justify-center mb-6">
          <Button
            variant={isRecording ? 'destructive' : 'default'}
            size="icon"
            className={cn('h-24 w-24 rounded-full', isRecording && 'animate-pulse')}
            onClick={handleMicPress}
            disabled={isTranscribing}
            title={
              isTranscribing
                ? 'Transcribing...'
                : isRecording
                  ? 'Stop recording'
                  : 'Start recording'
            }
          >
            {isTranscribing ? (
              <Loader2 className="h-10 w-10 animate-spin" />
            ) : (
              <Mic className="h-10 w-10" />
            )}
          </Button>
        </div>

        {/* Recording error display */}
        {recordingError && (
          <p className="text-center text-sm text-destructive mb-4">{recordingError}</p>
        )}

        {/* Send / Cancel buttons - only visible after transcript is ready */}
        {transcript && (
          <div className="flex justify-between gap-4">
            <Button
              variant="default"
              className="h-16 flex-1 bg-green-600 hover:bg-green-700 text-white text-lg"
              onClick={handleSend}
            >
              <Send className="h-5 w-5 mr-2" />
              Send
            </Button>
            <Button variant="destructive" className="h-16 flex-1 text-lg" onClick={handleCancel}>
              <X className="h-5 w-5 mr-2" />
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
