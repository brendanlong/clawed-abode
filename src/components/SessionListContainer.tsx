'use client';

import { useCallback, useState } from 'react';
import { SessionList } from '@/components/SessionList';
import { useSessionList } from '@/hooks/useSessionList';
import { useSessionListEvent } from '@/lib/session-list-stream-context';

/**
 * Wires the two paginated session queries (active, and archived once requested)
 * to the SessionList presentation component. Any session-list stream event (a
 * session changed, or Claude's turn/background state flipped, in any tab) and any
 * stream error (events may have been missed) refetch both lists; refetching beats
 * patching the cache because a page is one query and the event may reorder it.
 * Start/stop/delete mutations emit on that stream, so no per-mutation refetch is
 * needed. Tab-visibility and network reconnects are handled by React Query
 * (LIVE_QUERY_OPTIONS).
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
  useSessionListEvent(refetch, refetch);

  return (
    <SessionList
      active={active}
      archived={archived}
      showArchived={showArchived}
      onToggleArchived={() => setShowArchived((prev) => !prev)}
    />
  );
}
