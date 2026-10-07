import { useEffect } from 'react';
import { trpc } from '@/lib/trpc';

/**
 * Clear the session's "needs you" flag whenever it is set while this page is
 * visible. `attentionAt` is a timestamp so a refetched but unchanged row doesn't re-fire.
 */
export function useClearAttentionWhileViewing(sessionId: string, attentionAt: number | null) {
  const { mutate } = trpc.sessions.markSeen.useMutation();

  useEffect(() => {
    if (!attentionAt) return;
    const clearIfVisible = () => {
      if (!document.hidden) mutate({ sessionId });
    };
    clearIfVisible();
    document.addEventListener('visibilitychange', clearIfVisible);
    return () => document.removeEventListener('visibilitychange', clearIfVisible);
  }, [sessionId, attentionAt, mutate]);
}
