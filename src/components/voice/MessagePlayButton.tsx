'use client';

import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Play, Pause, Loader2 } from 'lucide-react';
import { useVoicePlaybackContext } from '@/hooks/useVoicePlayback';

interface MessagePlayButtonProps {
  messageId: string;
  text: string;
  className?: string;
}

/**
 * Play/pause button for reading assistant messages aloud via TTS.
 * Synchronizes with global playback state.
 */
export function MessagePlayButton({ messageId, text, className }: MessagePlayButtonProps) {
  const { isPlaying, currentMessageId, isLoading, play } = useVoicePlaybackContext();

  const isThisMessage = currentMessageId === messageId;
  const isThisPlaying = isThisMessage && isPlaying;
  const isThisLoading = isThisMessage && isLoading;

  const handleClick = useCallback(() => {
    play(messageId, text);
  }, [messageId, text, play]);

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleClick}
      className={className}
      title={isThisPlaying ? 'Pause' : 'Read aloud'}
    >
      {isThisLoading ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : isThisPlaying ? (
        <Pause className="h-3 w-3" />
      ) : (
        <Play className="h-3 w-3" />
      )}
    </Button>
  );
}
