'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { useAuth } from '@/lib/auth-context';
import { useNotification } from './useNotification';
import {
  parseViewedSessionId,
  shouldNotifyOnRunningChange,
} from '@/lib/work-complete-notification';

/**
 * App-level notifier: fires a "Claude finished" desktop notification whenever any
 * session that isn't currently being watched transitions from working (a
 * main-agent turn active) to idle.
 *
 * This replaces the old per-session-page hook (which only existed for the one
 * open session and only fired when the whole tab was hidden — issue #420). It
 * subscribes to the global session-list SSE stream (`emitClaudeRunning` fans out
 * per-session `turnActive` flips) so it covers *every* session regardless of
 * which page is open. A session is suppressed only when its page is on screen and
 * the tab is visible — i.e. you're actively watching it.
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

  // Per-session running (turnActive) state, so we can detect true -> false edges.
  const runningRef = useRef<Map<string, boolean>>(new Map());
  // Per-session display name for the notification body.
  const namesRef = useRef<Map<string, string>>(new Map());

  // Seed names and baseline running state from the list snapshot, so a session
  // already running when the notifier mounts is caught when it later finishes.
  // Only seed running for sessions we aren't already tracking live, so a query
  // refetch never clobbers a fresher value from the event stream.
  const { data: listData } = trpc.sessions.list.useQuery(
    { includeArchived: false },
    { enabled: isAuthenticated }
  );
  useEffect(() => {
    for (const session of listData?.sessions ?? []) {
      namesRef.current.set(session.id, session.name);
      if (!runningRef.current.has(session.id)) {
        runningRef.current.set(session.id, session.turnActive);
      }
    }
  }, [listData]);

  trpc.sse.onSessionListEvents.useSubscription(undefined, {
    enabled: isAuthenticated,
    onData: (tracked) => {
      const event = tracked.data;
      // Keep names current even for sessions off the home page (a session update
      // carries the full record); running edges are handled below.
      if (event.kind === 'session') {
        namesRef.current.set(event.session.id, event.session.name);
        return;
      }
      if (event.kind !== 'running') return;

      const { sessionId, running } = event;
      const wasRunning = runningRef.current.get(sessionId);
      runningRef.current.set(sessionId, running);

      const isWatching =
        sessionId === viewedSessionIdRef.current &&
        typeof document !== 'undefined' &&
        !document.hidden;

      if (shouldNotifyOnRunningChange({ wasRunning, nowRunning: running, isWatching })) {
        const name = namesRef.current.get(sessionId);
        void showNotification('Claude finished', {
          body: name ? `Work complete on ${name}` : 'Work complete',
          // Per-session tag so several sessions finishing don't collapse into one.
          tag: `work-complete-${sessionId}`,
        });
      }
    },
    onError: (err) => {
      console.error('Work-complete notifier SSE error:', err);
    },
  });
}
