'use client';

import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Play, Pause, Square, RotateCcw, Loader2 } from 'lucide-react';
import { useVoicePlaybackContext } from '@/hooks/useVoicePlayback';

interface MessagePlayButtonProps {
  messageId: string;
  text: string;
  className?: string;
}

/**
 * Play/pause/stop/restart controls for reading assistant messages aloud via TTS.
 * Synchronizes with global playback state.
 */
export function MessagePlayButton({ messageId, text, className }: MessagePlayButtonProps) {
  const { isPlaying, currentMessageId, isLoading, play, stop, restart } = useVoicePlaybackContext();

  const isThisMessage = currentMessageId === messageId;
  const isThisPlaying = isThisMessage && isPlaying;
  const isThisLoading = isThisMessage && isLoading;
  const isThisPaused = isThisMessage && !isPlaying && !isLoading;

  const handlePlay = useCallback(() => {
    play(messageId, text);
  }, [messageId, text, play]);

  // Idle or different message: show play button
  if (!isThisMessage) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={handlePlay}
        className={className}
        title="Read aloud"
      >
        <Play className="h-3 w-3" />
      </Button>
    );
  }

  // Loading: show spinner
  if (isThisLoading) {
    return (
      <Button variant="ghost" size="sm" disabled className={className} title="Loading audio...">
        <Loader2 className="h-3 w-3 animate-spin" />
      </Button>
    );
  }

  // Playing or paused: show control group
  return (
    <span className={`inline-flex items-center gap-0 ${className ?? ''}`}>
      {isThisPlaying ? (
        <Button variant="ghost" size="sm" onClick={handlePlay} title="Pause">
          <Pause className="h-3 w-3" />
        </Button>
      ) : isThisPaused ? (
        <>
          <Button variant="ghost" size="sm" onClick={handlePlay} title="Resume">
            <Play className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="sm" onClick={restart} title="Restart from beginning">
            <RotateCcw className="h-3 w-3" />
          </Button>
        </>
      ) : null}
      <Button variant="ghost" size="sm" onClick={stop} title="Stop">
        <Square className="h-3 w-3" />
      </Button>
    </span>
  );
}
