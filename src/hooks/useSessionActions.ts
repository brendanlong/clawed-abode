import { useCallback } from 'react';
import { trpc } from '@/lib/trpc';
import { useActionError } from '@/hooks/useActionError';

/**
 * Start/stop/archive for one session, with each action's pending state and the
 * latest failure. `handlersFor` is returned so a caller's own mutations (rename,
 * star) report into the same error slot.
 */
export function useSessionActions(
  sessionId: string,
  { onArchived }: { onArchived?: () => void } = {}
) {
  const { error: actionError, dismiss: dismissActionError, handlersFor } = useActionError();

  const startMutation = trpc.sessions.start.useMutation(handlersFor('start session'));
  const stopMutation = trpc.sessions.stop.useMutation(handlersFor('stop session'));
  // The API endpoint is "delete" but it archives instead of permanently deleting
  const archiveMutation = trpc.sessions.delete.useMutation({
    ...handlersFor('archive session'),
    onSuccess: onArchived,
  });

  const { mutate: startMutate } = startMutation;
  const { mutate: stopMutate } = stopMutation;
  const { mutate: archiveMutate } = archiveMutation;
  const start = useCallback(() => startMutate({ sessionId }), [sessionId, startMutate]);
  const stop = useCallback(() => stopMutate({ sessionId }), [sessionId, stopMutate]);
  const archive = useCallback(() => archiveMutate({ sessionId }), [sessionId, archiveMutate]);

  return {
    start,
    stop,
    archive,
    isStarting: startMutation.isPending,
    isStopping: stopMutation.isPending,
    isArchiving: archiveMutation.isPending,
    actionError,
    dismissActionError,
    handlersFor,
  };
}
