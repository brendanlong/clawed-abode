'use client';

import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Play, Pause, Square, RotateCcw } from 'lucide-react';
import { useVoicePlaybackContext } from '@/hooks/useVoicePlayback';

interface MessagePlayButtonProps {
  messageId: string;
  text: string;
  className?: string;
}

/**
 * Play/pause/stop/restart controls for reading assistant messages aloud via browser TTS.
 * Synchronizes with global playback state.
 */
export function MessagePlayButton({ messageId, text, className }: MessagePlayButtonProps) {
  const { isPlaying, currentMessageId, supportsPause, play, stop, restart } =
    useVoicePlaybackContext();

  const isThisMessage = currentMessageId === messageId;
  const isThisPlaying = isThisMessage && isPlaying;
  const isThisPaused = isThisMessage && !isPlaying;

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

  // Playing or paused: show control group
  return (
    <span className={`inline-flex items-center gap-0 ${className ?? ''}`}>
      {isThisPlaying ? (
        supportsPause ? (
          <Button variant="ghost" size="sm" onClick={handlePlay} title="Pause">
            <Pause className="h-3 w-3" />
          </Button>
        ) : null
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
