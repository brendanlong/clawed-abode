'use client';

import { useState } from 'react';
import { SessionList } from '@/components/SessionList';
import { useSessionList } from '@/hooks/useSessionList';

/**
 * Container component that wires up data fetching hooks with the SessionList presentation component.
 * This is the component that should be used in pages - it handles all tRPC interactions internally.
 */
export function SessionListContainer() {
  const [showArchived, setShowArchived] = useState(false);
  const { sessions, isLoading, refetch } = useSessionList({ includeArchived: showArchived });

  return (
    <SessionList
      sessions={sessions}
      isLoading={isLoading}
      onMutationSuccess={refetch}
      showArchived={showArchived}
      onToggleArchived={() => setShowArchived(!showArchived)}
    />
  );
}
