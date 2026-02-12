'use client';

import { Button } from '@/components/ui/button';
import { Volume2, VolumeX } from 'lucide-react';

interface VoiceAutoReadToggleProps {
  autoRead: boolean;
  onToggle: (value: boolean) => void;
}

/**
 * Toggle button in the session header for automatic TTS of assistant responses.
 */
export function VoiceAutoReadToggle({ autoRead, onToggle }: VoiceAutoReadToggleProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => onToggle(!autoRead)}
      title={autoRead ? 'Disable auto-read' : 'Enable auto-read'}
      className="shrink-0 h-8 w-8"
    >
      {autoRead ? (
        <Volume2 className="h-4 w-4" />
      ) : (
        <VolumeX className="h-4 w-4 text-muted-foreground" />
      )}
    </Button>
  );
}
