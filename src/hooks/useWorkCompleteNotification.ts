import { useEffect, useRef } from 'react';

/**
 * Hook for showing a notification when Claude finishes processing.
 * Only shows notification if the page was hidden while Claude was working.
 */
export function useWorkCompleteNotification(
  sessionName: string | undefined,
  isWorking: boolean,
  showNotification: (title: string, options?: NotificationOptions) => Promise<void>
) {
  const wasWorkingRef = useRef(false);
  const wasHiddenWhileWorkingRef = useRef(false);

  // Track when we become hidden while working
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && isWorking) {
        wasHiddenWhileWorkingRef.current = true;
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Also check initial state - if we're hidden and working, mark it
    if (document.hidden && isWorking) {
      wasHiddenWhileWorkingRef.current = true;
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isWorking]);

  // Detect transition from working to not working
  useEffect(() => {
    // When work completes (was working -> not working)
    if (wasWorkingRef.current && !isWorking && wasHiddenWhileWorkingRef.current) {
      // Only notify if we're still hidden (user hasn't come back yet)
      if (document.hidden && sessionName) {
        showNotification('Claude finished', {
          body: `Work complete on ${sessionName}`,
          tag: 'work-complete',
        });
      }
      wasHiddenWhileWorkingRef.current = false;
    }

    wasWorkingRef.current = isWorking;
  }, [isWorking, sessionName, showNotification]);
}
