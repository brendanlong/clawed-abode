'use client';

import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Mic } from 'lucide-react';
import { useVoiceRecording } from '@/hooks/useVoiceRecording';
import { cn } from '@/lib/utils';

interface VoiceMicButtonProps {
  onTranscript: (text: string) => void;
  disabled: boolean;
}

/**
 * Push-to-talk microphone button using browser SpeechRecognition.
 * First click starts recording, second click stops and returns transcript.
 * Shows interim transcript while recording.
 */
export function VoiceMicButton({ onTranscript, disabled }: VoiceMicButtonProps) {
  const { isRecording, isTranscribing, interimTranscript, startRecording, stopRecording, error } =
    useVoiceRecording();

  const handleClick = useCallback(async () => {
    if (isRecording) {
      try {
        const text = await stopRecording();
        if (text.trim()) {
          onTranscript(text);
        }
      } catch {
        // Error state handled by hook
      }
    } else {
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
        disabled={disabled || isTranscribing}
        title={
          isTranscribing ? 'Processing...' : isRecording ? 'Stop recording' : 'Start voice input'
        }
        className={cn('shrink-0', isRecording && 'animate-pulse')}
      >
        <Mic className="h-4 w-4" />
      </Button>
      {isRecording && interimTranscript && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-muted text-muted-foreground text-xs rounded whitespace-nowrap max-w-[200px] truncate">
          {interimTranscript}
        </div>
      )}
      {error && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-destructive text-destructive-foreground text-xs rounded whitespace-nowrap">
          {error}
        </div>
      )}
    </div>
  );
}
