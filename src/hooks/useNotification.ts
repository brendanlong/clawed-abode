'use client';

import { useCallback, useState } from 'react';

type NotificationPermission = 'default' | 'granted' | 'denied';

interface UseNotificationResult {
  /** Current notification permission status */
  permission: NotificationPermission;
  /** Request permission to show notifications */
  requestPermission: () => Promise<NotificationPermission>;
  /** Show a notification (will request permission if not already granted) */
  showNotification: (title: string, options?: NotificationOptions) => Promise<void>;
}

// Safe for SSR: false on the server.
const isSupported = (): boolean => typeof window !== 'undefined' && 'Notification' in window;

function getInitialPermission(): NotificationPermission {
  return isSupported() ? Notification.permission : 'default';
}

/**
 * Hook for managing browser notifications.
 * Handles permission requests and notification display.
 */
export function useNotification(): UseNotificationResult {
  const [permission, setPermission] = useState<NotificationPermission>(getInitialPermission);

  const requestPermission = useCallback(async (): Promise<NotificationPermission> => {
    if (!isSupported()) {
      return 'denied';
    }

    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      return result;
    } catch {
      return 'denied';
    }
  }, []);

  const showNotification = useCallback(
    async (title: string, options?: NotificationOptions) => {
      if (!isSupported()) {
        return;
      }

      let currentPermission = permission;

      // Request permission if not already granted
      if (currentPermission === 'default') {
        currentPermission = await requestPermission();
      }

      if (currentPermission !== 'granted') {
        return;
      }

      // Create and show the notification
      try {
        const notification = new Notification(title, {
          icon: '/favicon.svg',
          badge: '/favicon.svg',
          ...options,
        });

        // Auto-close after 10 seconds
        setTimeout(() => {
          notification.close();
        }, 10000);

        // Focus window when notification is clicked
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      } catch {
        // Notification creation failed (e.g., on iOS where Notifications API exists but doesn't work)
      }
    },
    [permission, requestPermission]
  );

  return {
    permission,
    requestPermission,
    showNotification,
  };
}
