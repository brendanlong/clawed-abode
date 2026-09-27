'use client';

import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Play, Pause, Square, RotateCcw, AlertCircle } from 'lucide-react';
import { useVoicePlaybackContext } from '@/hooks/useVoicePlayback';

interface MessagePlayButtonProps {
  messageId: string;
  text: string;
  className?: string;
}

/**
 * Play/pause/stop/restart controls for reading an assistant message aloud.
 * Synchronizes with global playback state.
 */
export function MessagePlayButton({ messageId, text, className }: MessagePlayButtonProps) {
  const { isPlaying, isLoading, currentMessageId, error, play, stop, restart } =
    useVoicePlaybackContext();

  const handlePlay = useCallback(() => {
    play(messageId, text);
  }, [messageId, text, play]);

  if (currentMessageId !== messageId) {
    const failure = error?.messageId === messageId ? error.message : null;
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={handlePlay}
        className={className}
        title={failure ? `Read aloud failed: ${failure}` : 'Read aloud'}
      >
        {failure ? (
          <AlertCircle className="h-3 w-3 text-destructive" />
        ) : (
          <Play className="h-3 w-3" />
        )}
      </Button>
    );
  }

  return (
    <span className={`inline-flex items-center gap-0 ${className ?? ''}`}>
      {isLoading ? (
        <Button variant="ghost" size="sm" disabled title="Preparing audio">
          <Spinner size="sm" className="h-3 w-3" />
        </Button>
      ) : isPlaying ? (
        <Button variant="ghost" size="sm" onClick={handlePlay} title="Pause">
          <Pause className="h-3 w-3" />
        </Button>
      ) : (
        <>
          <Button variant="ghost" size="sm" onClick={handlePlay} title="Resume">
            <Play className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="sm" onClick={restart} title="Restart from beginning">
            <RotateCcw className="h-3 w-3" />
          </Button>
        </>
      )}
      <Button variant="ghost" size="sm" onClick={stop} title="Stop">
        <Square className="h-3 w-3" />
      </Button>
    </span>
  );
}
