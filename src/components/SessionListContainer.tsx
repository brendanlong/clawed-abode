'use client';

import { useCallback, useState } from 'react';
import { SessionList } from '@/components/SessionList';
import { useSessionList } from '@/hooks/useSessionList';
import { useSessionListStream } from '@/hooks/useSessionListStream';

/**
 * Wires the two paginated session queries (active, and archived once requested)
 * to the SessionList presentation component. Start/stop/delete mutations emit on
 * the session-list stream, which refetches both, so no per-mutation refetch is needed.
 */
export function SessionListContainer() {
  const [showArchived, setShowArchived] = useState(false);
  const { refetch: refetchActive, ...active } = useSessionList();
  const { refetch: refetchArchived, ...archived } = useSessionList({
    status: 'archived',
    enabled: showArchived,
  });

  const refetch = useCallback(() => {
    refetchActive();
    if (showArchived) refetchArchived();
  }, [refetchActive, refetchArchived, showArchived]);
  useSessionListStream(refetch);

  return (
    <SessionList
      active={active}
      archived={archived}
      showArchived={showArchived}
      onToggleArchived={() => setShowArchived((prev) => !prev)}
    />
  );
}
