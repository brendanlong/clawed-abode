'use client';

import { useCallback, useState } from 'react';

type NotificationPermission = 'default' | 'granted' | 'denied';

interface UseNotificationResult {
  /** Current notification permission status */
  permission: NotificationPermission;
  /** Whether notifications are supported by the browser */
  isSupported: boolean;
  /** Request permission to show notifications */
  requestPermission: () => Promise<NotificationPermission>;
  /** Show a notification (will request permission if not already granted) */
  showNotification: (title: string, options?: NotificationOptions) => Promise<void>;
}

// Check if notifications are supported (safe for SSR)
function getInitialSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

// Get initial permission status (safe for SSR)
function getInitialPermission(): NotificationPermission {
  if (typeof window !== 'undefined' && 'Notification' in window) {
    return Notification.permission;
  }
  return 'default';
}

/**
 * Hook for managing browser notifications.
 * Handles permission requests and notification display.
 */
export function useNotification(): UseNotificationResult {
  const [permission, setPermission] = useState<NotificationPermission>(getInitialPermission);
  const [isSupported] = useState<boolean>(getInitialSupported);

  const requestPermission = useCallback(async (): Promise<NotificationPermission> => {
    if (!isSupported) {
      return 'denied';
    }

    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      return result;
    } catch {
      return 'denied';
    }
  }, [isSupported]);

  const showNotification = useCallback(
    async (title: string, options?: NotificationOptions) => {
      if (!isSupported) {
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
    [isSupported, permission, requestPermission]
  );

  return {
    permission,
    isSupported,
    requestPermission,
    showNotification,
  };
}
