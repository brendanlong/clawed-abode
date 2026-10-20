import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { useActionError } from '@/hooks/useActionError';
import { useSessionStreamState } from '@/hooks/useSessionStream';

/**
 * Hook for managing session state: the session row (kept by the session stream)
 * and start/stop/rename/archive mutations. Every mutation that changes the row
 * announces it on the stream, so none writes the row itself.
 */
export function useSessionState(sessionId: string) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { error: actionError, dismiss: dismissActionError, handlersFor } = useActionError();

  const session = useSessionStreamState(sessionId)?.session;

  const startMutation = trpc.sessions.start.useMutation(handlersFor('start session'));
  const stopMutation = trpc.sessions.stop.useMutation(handlersFor('stop session'));
  const renameMutation = trpc.sessions.rename.useMutation(handlersFor('rename session'));

  // The API endpoint is "delete" but it now archives instead of permanently deleting
  const archiveMutation = trpc.sessions.delete.useMutation({
    ...handlersFor('archive session'),
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
    session,
    start,
    stop,
    archive,
    rename,
    isStarting: startMutation.isPending,
    isStopping: stopMutation.isPending,
    isArchiving: archiveMutation.isPending,
    actionError,
    dismissActionError,
  };
}
