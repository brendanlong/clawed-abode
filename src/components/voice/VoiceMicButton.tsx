'use client';

import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Mic, Loader2 } from 'lucide-react';
import { useVoiceRecording } from '@/hooks/useVoiceRecording';
import { cn } from '@/lib/utils';

interface VoiceMicButtonProps {
  onTranscript: (text: string) => void;
  disabled: boolean;
}

/**
 * Push-to-talk microphone button.
 * First click starts recording, second click stops and transcribes.
 * Transcript is returned to parent (not auto-sent).
 */
export function VoiceMicButton({ onTranscript, disabled }: VoiceMicButtonProps) {
  const { isRecording, isTranscribing, startRecording, stopRecording, error } = useVoiceRecording();

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
          isTranscribing ? 'Transcribing...' : isRecording ? 'Stop recording' : 'Start voice input'
        }
        className={cn('shrink-0', isRecording && 'animate-pulse')}
      >
        {isTranscribing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
      </Button>
      {error && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-destructive text-destructive-foreground text-xs rounded whitespace-nowrap">
          {error}
        </div>
      )}
    </div>
  );
}
