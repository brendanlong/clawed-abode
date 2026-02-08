'use client';

import { useCallback, useState } from 'react';
import { trpc } from '@/lib/trpc';

export interface SessionActions {
  start: (sessionId: string) => void;
  stop: (sessionId: string) => void;
  archive: (sessionId: string) => void;
  isStarting: (sessionId: string) => boolean;
  isStopping: (sessionId: string) => boolean;
  isArchiving: (sessionId: string) => boolean;
}

/**
 * Creates mutation options that track all concurrently pending session IDs,
 * not just the most recent one.
 */
function usePendingSet() {
  const [pending, setPending] = useState<Set<string>>(() => new Set());

  const add = useCallback((sessionId: string) => {
    setPending((prev) => new Set(prev).add(sessionId));
  }, []);

  const remove = useCallback((sessionId: string) => {
    setPending((prev) => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const has = useCallback((sessionId: string) => pending.has(sessionId), [pending]);

  return { add, remove, has };
}

/**
 * Hook for session mutation actions (start, stop, archive).
 * Separates mutation logic from presentation.
 *
 * @param onSuccess - Callback to run after any successful mutation (e.g., refetch list)
 */
export function useSessionActions(onSuccess?: () => void): SessionActions {
  const startPending = usePendingSet();
  const stopPending = usePendingSet();
  const archivePending = usePendingSet();

  const startMutation = trpc.sessions.start.useMutation({
    onMutate: ({ sessionId }) => startPending.add(sessionId),
    onSettled: (_data, _error, { sessionId }) => startPending.remove(sessionId),
    onSuccess,
  });

  const stopMutation = trpc.sessions.stop.useMutation({
    onMutate: ({ sessionId }) => stopPending.add(sessionId),
    onSettled: (_data, _error, { sessionId }) => stopPending.remove(sessionId),
    onSuccess,
  });

  // The API endpoint is "delete" but it now archives instead of permanently deleting
  const archiveMutation = trpc.sessions.delete.useMutation({
    onMutate: ({ sessionId }) => archivePending.add(sessionId),
    onSettled: (_data, _error, { sessionId }) => archivePending.remove(sessionId),
    onSuccess,
  });

  return {
    start: (sessionId: string) => startMutation.mutate({ sessionId }),
    stop: (sessionId: string) => stopMutation.mutate({ sessionId }),
    archive: (sessionId: string) => archiveMutation.mutate({ sessionId }),
    isStarting: startPending.has,
    isStopping: stopPending.has,
    isArchiving: archivePending.has,
  };
}
