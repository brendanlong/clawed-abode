import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { useSessionActions } from '@/hooks/useSessionActions';
import { useSessionStreamState } from '@/hooks/useSessionStream';

/**
 * Hook for managing session state: the session row (kept by the session stream)
 * and start/stop/rename/archive mutations. Every mutation that changes the row
 * announces it on the stream, so none writes the row itself.
 */
export function useSessionState(sessionId: string) {
  const router = useRouter();
  const utils = trpc.useUtils();

  const session = useSessionStreamState(sessionId)?.session;

  const { handlersFor, ...actions } = useSessionActions(sessionId, {
    onArchived: () => {
      void utils.sessions.list.invalidate();
      router.push('/');
    },
  });
  const { mutate: renameMutate } = trpc.sessions.rename.useMutation(handlersFor('rename session'));

  const rename = useCallback(
    (name: string) => renameMutate({ sessionId, name }),
    [sessionId, renameMutate]
  );

  return { session, ...actions, rename };
}
