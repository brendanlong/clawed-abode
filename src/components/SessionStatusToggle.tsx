'use client';

import { SessionActionButton } from '@/components/SessionActionButton';
import { SessionStatusBadge } from '@/components/SessionStatusBadge';
import { deriveSessionDisplayStatus } from '@/lib/session-display-status';

interface SessionStatusToggleProps {
  status: string;
  /** Passed only when the server says the session can be started / stopped; otherwise the status renders as a badge. */
  onStart?: () => void;
  onStop?: () => void;
  isStarting?: boolean;
  isStopping?: boolean;
}

/**
 * Status display that doubles as a toggle: a session that can be stopped or
 * started renders as a button labelled with its status that flips it on click.
 * Otherwise it renders a static badge.
 */
export function SessionStatusToggle({
  status,
  onStart,
  onStop,
  isStarting = false,
  isStopping = false,
}: SessionStatusToggleProps) {
  if (onStop) {
    return (
      <SessionActionButton action="stop" label="Running" onClick={onStop} isPending={isStopping} />
    );
  }
  if (onStart) {
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
