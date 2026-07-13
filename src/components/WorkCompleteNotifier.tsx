'use client';

import { useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useNotification } from '@/hooks/useNotification';
import { useWorkCompleteNotifications } from '@/hooks/useWorkCompleteNotifications';

/**
 * Mounts the app-level work-complete notifier (issue #420) and requests
 * notification permission once the user is authenticated (not on the login page).
 * Renders nothing. Mounted once, app-wide, so notifications fire for every
 * session — not just the one currently open.
 */
export function WorkCompleteNotifier() {
  useWorkCompleteNotifications();

  const { isAuthenticated } = useAuth();
  const { requestPermission, permission } = useNotification();
  useEffect(() => {
    if (isAuthenticated && permission === 'default') {
      void requestPermission();
    }
  }, [isAuthenticated, permission, requestPermission]);

  return null;
}
