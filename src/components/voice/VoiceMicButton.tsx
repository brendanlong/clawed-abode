'use client';

import { Button } from '@/components/ui/button';
import { Mic } from 'lucide-react';
import { cn } from '@/lib/utils';

interface VoiceMicButtonProps {
  isRecording: boolean;
  onClick: () => void;
  disabled: boolean;
  error: string | null;
}

/**
 * Microphone button for voice input. Presentational component —
 * recording state and controls are managed by the parent.
 */
export function VoiceMicButton({ isRecording, onClick, disabled, error }: VoiceMicButtonProps) {
  return (
    <div className="relative">
      <Button
        type="button"
        variant={isRecording ? 'destructive' : 'outline'}
        size="icon"
        onClick={onClick}
        disabled={disabled}
        title={isRecording ? 'Stop recording' : 'Start voice input'}
        className={cn('shrink-0', isRecording && 'animate-pulse')}
      >
        <Mic className="h-4 w-4" />
      </Button>
      {error && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-destructive text-destructive-foreground text-xs rounded whitespace-nowrap">
          {error}
        </div>
      )}
    </div>
  );
}
