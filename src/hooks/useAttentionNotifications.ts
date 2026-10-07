'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useSessionListEvent } from '@/lib/session-list-stream-context';
import { useNotification } from './useNotification';
import { parseViewedSessionId, isActivelyWatching } from '@/lib/attention-notification';

/**
 * App-level notifier: a desktop notification whenever an agent in any session
 * asks for the user, except the session being actively watched. Mounted exactly
 * once, inside SessionListStreamProvider.
 */
export function useAttentionNotifications() {
  const pathname = usePathname();
  const { showNotification } = useNotification();

  // In a ref so the subscription callback (a stable closure) reads the current value.
  const viewedSessionId = parseViewedSessionId(pathname);
  const viewedSessionIdRef = useRef<string | null>(viewedSessionId);
  useEffect(() => {
    viewedSessionIdRef.current = viewedSessionId;
  }, [viewedSessionId]);

  useSessionListEvent((event) => {
    if (event.kind !== 'attention') return;
    const watching = isActivelyWatching({
      sessionId: event.sessionId,
      viewedSessionId: viewedSessionIdRef.current,
      tabHidden: typeof document !== 'undefined' && document.hidden,
    });
    if (watching) return;

    // No tag: a same-tag notification replaces the old one silently, and each
    // request should alert.
    void showNotification(event.name, { body: event.summary });
  });
}
