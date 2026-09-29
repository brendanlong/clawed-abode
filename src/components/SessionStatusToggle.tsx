'use client';

import { SessionActionButton } from '@/components/SessionActionButton';
import { SessionStatusBadge } from '@/components/SessionStatusBadge';
import { deriveSessionDisplayStatus } from '@/lib/session-display-status';

interface SessionStatusToggleProps {
  status: string;
  /** Omitted where the session can't be toggled; the status then renders as a badge. */
  onStart?: () => void;
  onStop?: () => void;
  isStarting?: boolean;
  isStopping?: boolean;
}

/**
 * Status display that doubles as a toggle: a running or stopped session renders
 * as a button labelled with its status that flips it on click. Other statuses
 * (creating, error, archived) render a static badge.
 */
export function SessionStatusToggle({
  status,
  onStart,
  onStop,
  isStarting = false,
  isStopping = false,
}: SessionStatusToggleProps) {
  if (status === 'running' && onStop) {
    return (
      <SessionActionButton action="stop" label="Running" onClick={onStop} isPending={isStopping} />
    );
  }
  if (status === 'stopped' && onStart) {
    return (
      <SessionActionButton
        action="start"
        label="Stopped"
        variant="secondary"
        onClick={onStart}
        isPending={isStarting}
      />
    );
  }
  return <SessionStatusBadge status={deriveSessionDisplayStatus(status, false)} />;
}
