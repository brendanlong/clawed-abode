'use client';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { SessionStatusBadge } from '@/components/SessionStatusBadge';

interface SessionStatusToggleProps {
  status: string;
  onStart: () => void;
  onStop: () => void;
  isStarting: boolean;
  isStopping: boolean;
}

/**
 * Combined status display and toggle button.
 * When the container is running or stopped, renders as a clickable button
 * that shows the status and toggles it on click.
 * For other statuses (creating, error, archived), renders a static badge.
 */
export function SessionStatusToggle({
  status,
  onStart,
  onStop,
  isStarting,
  isStopping,
}: SessionStatusToggleProps) {
  if (status === 'running') {
    return (
      <Button size="sm" variant="default" onClick={onStop} disabled={isStopping}>
        {isStopping ? (
          <>
            <Spinner size="sm" className="mr-2" />
            Stopping...
          </>
        ) : (
          'Running'
        )}
      </Button>
    );
  }

  if (status === 'stopped') {
    return (
      <Button size="sm" variant="secondary" onClick={onStart} disabled={isStarting}>
        {isStarting ? (
          <>
            <Spinner size="sm" className="mr-2" />
            Starting...
          </>
        ) : (
          'Stopped'
        )}
      </Button>
    );
  }

  // For non-toggleable statuses (creating, error, archived), show a static badge
  return <SessionStatusBadge status={status} />;
}
