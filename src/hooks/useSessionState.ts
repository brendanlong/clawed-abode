import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { LIVE_QUERY_OPTIONS } from '@/lib/live-query';

/**
 * Hook for managing session state: fetching session data, SSE updates, and start/stop mutations.
 */
export function useSessionState(sessionId: string) {
  const router = useRouter();
  const utils = trpc.useUtils();

  // Live session updates arrive via the multiplexed SSE stream (useSessionStream).
  const { data: sessionData, isLoading } = trpc.sessions.get.useQuery(
    { sessionId },
    LIVE_QUERY_OPTIONS
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

  const renameMutation = trpc.sessions.rename.useMutation({
    onSuccess: (data) => {
      utils.sessions.get.setData({ sessionId }, { session: data.session });
    },
  });

  // The API endpoint is "delete" but it now archives instead of permanently deleting
  const archiveMutation = trpc.sessions.delete.useMutation({
    onSuccess: () => {
      void utils.sessions.list.invalidate();
      router.push('/');
    },
  });

  const start = useCallback(() => {
    startMutation.mutate({ sessionId });
  }, [sessionId, startMutation]);

  const stop = useCallback(() => {
    stopMutation.mutate({ sessionId });
  }, [sessionId, stopMutation]);

  const archive = useCallback(() => {
    archiveMutation.mutate({ sessionId });
  }, [sessionId, archiveMutation]);

  const rename = useCallback(
    (name: string) => {
      renameMutation.mutate({ sessionId, name });
    },
    [sessionId, renameMutation]
  );

  return {
    session: sessionData?.session,
    isLoading,
    start,
    stop,
    archive,
    rename,
    isStarting: startMutation.isPending,
    isStopping: stopMutation.isPending,
    isArchiving: archiveMutation.isPending,
  };
}
