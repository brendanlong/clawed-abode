'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useSessionListEvent } from '@/lib/session-list-stream-context';
import { parseViewedSessionId, isActivelyWatching } from '@/lib/attention-notification';

const NOTIFICATION_TIMEOUT_MS = 10_000;

// False during SSR and in browsers without the Notifications API.
const isSupported = (): boolean => typeof window !== 'undefined' && 'Notification' in window;

/** Ask for permission if the user hasn't decided yet; resolves whether we may notify. */
async function ensurePermission(): Promise<boolean> {
  if (!isSupported()) return false;
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      return false;
    }
  }
  return Notification.permission === 'granted';
}

async function showNotification(title: string, body: string): Promise<void> {
  if (!(await ensurePermission())) return;
  try {
    // No tag: a same-tag notification replaces the old one silently, and each
    // request should alert.
    const notification = new Notification(title, {
      body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
    });
    setTimeout(() => notification.close(), NOTIFICATION_TIMEOUT_MS);
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Creation fails on iOS, where the Notifications API exists but doesn't work.
  }
}

/**
 * App-level notifier: a desktop notification whenever an agent in any session
 * asks for the user, except the session being actively watched. Requests
 * permission once the user is authenticated (not on the login page). Renders
 * nothing; mounted once, inside SessionListStreamProvider.
 */
export function AttentionNotifier() {
  const viewedSessionId = parseViewedSessionId(usePathname());
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (isAuthenticated) void ensurePermission();
  }, [isAuthenticated]);

  // useSessionListEvent always calls the latest handler, so this reads the
  // current viewedSessionId.
  useSessionListEvent((event) => {
    if (event.kind !== 'attention') return;
    const watching = isActivelyWatching({
      sessionId: event.sessionId,
      viewedSessionId,
      tabHidden: document.hidden,
    });
    if (!watching) void showNotification(event.name, event.summary);
  });

  return null;
}
