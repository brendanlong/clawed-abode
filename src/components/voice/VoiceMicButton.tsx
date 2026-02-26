'use client';

import { useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Mic, Loader2 } from 'lucide-react';
import { useVoiceRecording } from '@/hooks/useVoiceRecording';
import { detectTriggerWord } from '@/lib/trigger-word';
import { cn } from '@/lib/utils';

interface VoiceMicButtonProps {
  onTranscript: (text: string) => void;
  onLiveTranscript?: (text: string) => void;
  disabled: boolean;
  triggerWord?: string | null;
}

/**
 * Streaming voice microphone button.
 * First click starts streaming transcription, second click stops.
 * Live transcript is streamed to parent via onLiveTranscript.
 * If triggerWord is configured, auto-submits when trigger is detected.
 */
export function VoiceMicButton({
  onTranscript,
  onLiveTranscript,
  disabled,
  triggerWord,
}: VoiceMicButtonProps) {
  const { isRecording, isConnecting, liveTranscript, startRecording, stopRecording, error } =
    useVoiceRecording();

  // Track if we already auto-submitted via trigger word to avoid double-submit
  const autoSubmittedRef = useRef(false);

  // Forward live transcript to parent
  useEffect(() => {
    if (onLiveTranscript) {
      onLiveTranscript(liveTranscript);
    }
  }, [liveTranscript, onLiveTranscript]);

  // Check for trigger word in live transcript
  useEffect(() => {
    if (!triggerWord || !liveTranscript || !isRecording || autoSubmittedRef.current) {
      return;
    }

    const result = detectTriggerWord(liveTranscript, triggerWord);
    if (result !== null) {
      autoSubmittedRef.current = true;
      stopRecording();
      if (result.trim()) {
        onTranscript(result);
      }
    }
  }, [liveTranscript, triggerWord, isRecording, stopRecording, onTranscript]);

  const handleClick = useCallback(async () => {
    if (isRecording) {
      const text = stopRecording();
      autoSubmittedRef.current = false;
      if (text.trim()) {
        onTranscript(text);
      }
    } else {
      autoSubmittedRef.current = false;
      await startRecording();
    }
  }, [isRecording, startRecording, stopRecording, onTranscript]);

  return (
    <div className="relative">
      <Button
        type="button"
        variant={isRecording ? 'destructive' : 'outline'}
        size="icon"
        onClick={handleClick}
        disabled={disabled || isConnecting}
        title={
          isConnecting ? 'Connecting...' : isRecording ? 'Stop recording' : 'Start voice input'
        }
        className={cn('shrink-0', isRecording && 'animate-pulse')}
      >
        {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
      </Button>
      {error && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-destructive text-destructive-foreground text-xs rounded whitespace-nowrap">
          {error}
        </div>
      )}
    </div>
  );
}
