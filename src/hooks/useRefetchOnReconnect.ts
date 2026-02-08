import { useEffect } from 'react';

/**
 * Hook to refetch data when the app regains visibility or network reconnects.
 * This handles cases where SSE connection was lost and the UI shows stale state.
 */
export function useRefetchOnReconnect(refetch: () => void) {
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refetch();
      }
    };

    const handleOnline = () => {
      refetch();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
    };
  }, [refetch]);
}
