import { useCallback } from 'react';
import { trpc } from '@/lib/trpc';
import { useRefetchOnReconnect } from './useRefetchOnReconnect';

/**
 * Hook for managing session state: fetching session data, SSE updates, and start/stop mutations.
 */
export function useSessionState(sessionId: string) {
  const utils = trpc.useUtils();

  // Fetch session details
  const { data: sessionData, isLoading, refetch } = trpc.sessions.get.useQuery({ sessionId });

  // Refetch session data when app regains visibility or network reconnects
  useRefetchOnReconnect(refetch);

  // Subscribe to session updates via SSE - update cache directly
  trpc.sse.onSessionUpdate.useSubscription(
    { sessionId },
    {
      onData: (trackedData) => {
        const session = trackedData.data.session as NonNullable<typeof sessionData>['session'];
        utils.sessions.get.setData({ sessionId }, { session });
      },
      onError: (err) => {
        console.error('Session SSE error:', err);
      },
    }
  );

  // Mutations - update cache directly from returned data
  const startMutation = trpc.sessions.start.useMutation({
    onSuccess: (data) => {
      utils.sessions.get.setData({ sessionId }, { session: data.session });
    },
  });

  const stopMutation = trpc.sessions.stop.useMutation({
    onSuccess: (data) => {
      utils.sessions.get.setData({ sessionId }, { session: data.session });
    },
  });

  // The API endpoint is "delete" but it now archives instead of permanently deleting
  // Session update comes via SSE subscription, so no onSuccess handler needed
  const archiveMutation = trpc.sessions.delete.useMutation();

  const start = useCallback(() => {
    startMutation.mutate({ sessionId });
  }, [sessionId, startMutation]);

  const stop = useCallback(() => {
    stopMutation.mutate({ sessionId });
  }, [sessionId, stopMutation]);

  const archive = useCallback(() => {
    archiveMutation.mutate({ sessionId });
  }, [sessionId, archiveMutation]);

  return {
    session: sessionData?.session,
    isLoading,
    start,
    stop,
    archive,
    isStarting: startMutation.isPending,
    isStopping: stopMutation.isPending,
    isArchiving: archiveMutation.isPending,
  };
}
