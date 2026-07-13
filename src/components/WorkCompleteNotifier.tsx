'use client';

import { useEffect } from 'react';
import { useNotification } from '@/hooks/useNotification';
import { useWorkCompleteNotifications } from '@/hooks/useWorkCompleteNotifications';

/**
 * Mounts the app-level work-complete notifier (issue #420) and proactively
 * requests notification permission. Renders nothing. Mounted once, app-wide, so
 * notifications fire for every session — not just the one currently open.
 */
export function WorkCompleteNotifier() {
  useWorkCompleteNotifications();

  const { requestPermission, permission } = useNotification();
  useEffect(() => {
    if (permission === 'default') {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  return null;
}
