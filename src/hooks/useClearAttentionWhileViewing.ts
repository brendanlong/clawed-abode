import { useEffect } from 'react';
import { trpc } from '@/lib/trpc';

/** Clear the session's "needs you" flag whenever it is set while this page is visible. */
export function useClearAttentionWhileViewing(sessionId: string, needsAttention: boolean) {
  const { mutate } = trpc.sessions.markSeen.useMutation();

  useEffect(() => {
    if (!needsAttention) return;
    const clearIfVisible = () => {
      if (!document.hidden) mutate({ sessionId });
    };
    clearIfVisible();
    document.addEventListener('visibilitychange', clearIfVisible);
    return () => document.removeEventListener('visibilitychange', clearIfVisible);
  }, [sessionId, needsAttention, mutate]);
}
