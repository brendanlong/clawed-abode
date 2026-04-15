'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { X, Mic, Square, Play, Pause, SkipBack, SkipForward, Send } from 'lucide-react';
import { useVoicePlaybackContext } from '@/hooks/useVoicePlayback';
import { useVoiceRecording } from '@/hooks/useVoiceRecording';
import { useVoiceConfig } from '@/hooks/useVoiceConfig';
import { extractAssistantText } from '@/lib/auto-read-helpers';
import { cn } from '@/lib/utils';

/** Minimal message shape passed into the panel */
interface PanelMessage {
  id: string;
  type: string;
  content: unknown;
  sequence: number;
}

interface VoiceControlPanelProps {
  sessionId: string;
  messages: PanelMessage[];
  isRunning: boolean;
  onSendPrompt: (prompt: string) => void;
  onClose: () => void;
  onInterrupt: () => void;
}

/** An assistant message with extractable text, for prev/next navigation */
interface AssistantTextEntry {
  id: string;
  text: string;
}

/**
 * Build a list of assistant messages that have meaningful text content.
 * Used for prev/next navigation in the panel.
 */
function getAssistantTextMessages(messages: PanelMessage[]): AssistantTextEntry[] {
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
 * Inline voice controls panel that replaces PromptInput when voice mode is active.
 * Renders as a normal flow element (not a modal/overlay) at the bottom of the session view.
 * Provides playback navigation, a large mic button, and send/cancel for transcripts.
 */
export function VoiceControlPanel({
  sessionId,
  messages,
  isRunning,
  onSendPrompt,
  onClose,
  onInterrupt,
}: VoiceControlPanelProps) {
  const playback = useVoicePlaybackContext();
  const voiceConfig = useVoiceConfig(sessionId);

  const {
    isRecording,
    interimTranscript,
    startRecording,
    stopRecording,
    error: recordingError,
  } = useVoiceRecording();

  // Transcript from the last recording, before user decides to send or cancel
  const [pendingTranscript, setPendingTranscript] = useState<string | null>(null);

  // Wake Lock to keep screen awake while voice panel is open
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

  // Play/pause/stop toggle
  const handlePlayPause = useCallback(() => {
    if (playback.isPlaying) {
      if (playback.supportsPause) {
        playback.pause();
      } else {
        playback.stop();
      }
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
  const handleMicPress = () => {
    if (isRecording) {
      const transcript = stopRecording();
      const fullText = transcript.trim();

      if (fullText) {
        if (voiceConfig.autoSend) {
          onSendPrompt(fullText);
        } else {
          setPendingTranscript(fullText);
        }
      }
    } else {
      setPendingTranscript(null);
      startRecording();
    }
  };

  // Send the transcript
  const handleSend = useCallback(() => {
    if (pendingTranscript) {
      onSendPrompt(pendingTranscript);
      setPendingTranscript(null);
    }
  }, [pendingTranscript, onSendPrompt]);

  // Cancel the transcript
  const handleCancel = useCallback(() => {
    setPendingTranscript(null);
  }, []);

  const hasPrev = assistantTextMessages.length > 0 && currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < assistantTextMessages.length - 1;
  const hasPlayableContent = assistantTextMessages.length > 0;

  // Live display text during recording (hook now tracks full transcript internally)
  const liveText = interimTranscript.trim();

  return (
    <div className="border-t bg-background flex-shrink-0">
      {/* Status line */}
      <div className="px-4 py-2 text-center text-sm text-muted-foreground">
        {isRecording
          ? liveText
            ? `"${liveText}"`
            : 'Listening...'
          : isRunning
            ? 'Claude is working...'
            : pendingTranscript
              ? 'Review transcript'
              : 'Voice mode'}
      </div>

      {/* Transcript review area */}
      {pendingTranscript && (
        <div className="px-4 pb-2">
          <div className="rounded-md border bg-muted/50 p-3">
            <p className="text-sm text-foreground">{pendingTranscript}</p>
          </div>
        </div>
      )}

      {/* Recording error display */}
      {recordingError && (
        <p className="text-center text-sm text-destructive px-4 pb-2">{recordingError}</p>
      )}

      {/* Playback controls row */}
      <div className="px-4 py-2">
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            size="icon"
            className="h-12 w-12 rounded-full"
            onClick={handlePrev}
            disabled={!hasPrev}
            title="Previous message"
          >
            <SkipBack className="h-5 w-5" />
          </Button>

          <Button
            variant={playback.isPlaying ? 'secondary' : 'default'}
            size="icon"
            className="h-12 w-12 rounded-full"
            onClick={handlePlayPause}
            disabled={!hasPlayableContent && !playback.isPlaying}
            title={playback.isPlaying ? (playback.supportsPause ? 'Pause' : 'Stop') : 'Play'}
          >
            {playback.isPlaying ? (
              playback.supportsPause ? (
                <Pause className="h-5 w-5" />
              ) : (
                <Square className="h-5 w-5" />
              )
            ) : (
              <Play className="h-5 w-5" />
            )}
          </Button>

          <Button
            variant="outline"
            size="icon"
            className="h-12 w-12 rounded-full"
            onClick={handleNext}
            disabled={!hasNext}
            title="Next message"
          >
            <SkipForward className="h-5 w-5" />
          </Button>

          {playback.supportsPause && (
            <Button
              variant="outline"
              size="icon"
              className="h-12 w-12 rounded-full"
              onClick={playback.stop}
              disabled={!playback.currentMessageId}
              title="Stop playback"
            >
              <Square className="h-5 w-5" />
            </Button>
          )}
        </div>
      </div>

      {/* Large mic button + interrupt */}
      <div className="px-4 py-3">
        <div className="flex items-center justify-center gap-4">
          {isRunning && (
            <Button
              variant="destructive"
              size="icon"
              className="h-14 w-14 rounded-full"
              onClick={onInterrupt}
              title="Interrupt Claude"
            >
              <Square className="h-6 w-6" />
            </Button>
          )}

          <Button
            variant={isRecording ? 'destructive' : 'default'}
            size="icon"
            className={cn('h-20 w-20 rounded-full', isRecording && 'animate-pulse')}
            onClick={handleMicPress}
            title={isRecording ? 'Stop recording' : 'Start recording'}
          >
            <Mic className="h-8 w-8" />
          </Button>
        </div>
      </div>

      {/* Send / Cancel buttons - only visible after transcript is ready */}
      {pendingTranscript && (
        <div className="flex gap-3 px-4 pb-3">
          <Button
            variant="default"
            className="h-12 flex-1 bg-green-600 hover:bg-green-700 text-white"
            onClick={handleSend}
          >
            <Send className="h-4 w-4 mr-2" />
            Send
          </Button>
          <Button variant="destructive" className="h-12 flex-1" onClick={handleCancel}>
            <X className="h-4 w-4 mr-2" />
            Cancel
          </Button>
        </div>
      )}

      {/* Exit voice mode */}
      <div className="px-4 pb-4">
        <Button variant="ghost" className="w-full text-muted-foreground" onClick={onClose}>
          <X className="h-4 w-4 mr-1" />
          Exit Voice Mode
        </Button>
      </div>
    </div>
  );
}
