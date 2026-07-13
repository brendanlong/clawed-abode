'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { useAuth } from '@/lib/auth-context';
import { useNotification } from './useNotification';
import { parseViewedSessionId, isActivelyWatching } from '@/lib/work-complete-notification';

/**
 * App-level notifier: fires a "Claude finished" desktop notification whenever any
 * session that isn't currently being watched completes a turn.
 *
 * This replaces the old per-session-page hook (which only existed for the one
 * open session and only fired when the whole tab was hidden — issue #420). It
 * subscribes to the global session-list SSE stream, keying off the `finished`
 * event (`emitClaudeFinished` — a *natural* turn end; the server excludes
 * interrupt/stop/error, so we never notify "finished" for work the user cancelled).
 * It covers every session regardless of which page is open, and suppresses only
 * the session whose page is on screen while the tab is visible — i.e. the one
 * you're actively watching.
 *
 * Meant to be mounted exactly once, app-wide. It is inert until authenticated.
 */
export function useWorkCompleteNotifications() {
  const { isAuthenticated } = useAuth();
  const pathname = usePathname();
  const { showNotification } = useNotification();

  // Latest viewed session id, in a ref so the subscription callback (a stable
  // closure) always reads the current value without re-subscribing.
  const viewedSessionId = parseViewedSessionId(pathname);
  const viewedSessionIdRef = useRef<string | null>(viewedSessionId);
  useEffect(() => {
    viewedSessionIdRef.current = viewedSessionId;
  }, [viewedSessionId]);

  // Per-session display name for the notification body. Seeded from the list
  // snapshot and kept current from `session` events (a `finished` event carries
  // only the id).
  const namesRef = useRef<Map<string, string>>(new Map());
  const { data: listData } = trpc.sessions.list.useQuery(
    { includeArchived: false },
    { enabled: isAuthenticated }
  );
  useEffect(() => {
    for (const session of listData?.sessions ?? []) {
      namesRef.current.set(session.id, session.name);
    }
  }, [listData]);

  trpc.sse.onSessionListEvents.useSubscription(undefined, {
    enabled: isAuthenticated,
    onData: (tracked) => {
      const event = tracked.data;
      // Keep names current even for sessions off the home page (a session update
      // carries the full record).
      if (event.kind === 'session') {
        namesRef.current.set(event.session.id, event.session.name);
        return;
      }
      if (event.kind !== 'finished') return;

      const watching = isActivelyWatching({
        finishedSessionId: event.sessionId,
        viewedSessionId: viewedSessionIdRef.current,
        tabHidden: typeof document !== 'undefined' && document.hidden,
      });
      if (watching) return;

      const name = namesRef.current.get(event.sessionId);
      void showNotification('Claude finished', {
        body: name ? `Work complete on ${name}` : 'Work complete',
        // Per-session tag so several sessions finishing don't collapse into one.
        tag: `work-complete-${event.sessionId}`,
      });
    },
    onError: (err) => {
      console.error('Work-complete notifier SSE error:', err);
    },
  });
}
