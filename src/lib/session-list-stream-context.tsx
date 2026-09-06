'use client';

import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { trpc } from '@/lib/trpc';
import { useAuth } from '@/lib/auth-context';
import type { SessionListStreamEvent } from '@/server/routers/sse';

type Handler = (event: SessionListStreamEvent) => void;
type Subscribe = (handler: Handler) => () => void;

const SessionListStreamContext = createContext<Subscribe | undefined>(undefined);

/**
 * Owns the app's single subscription to the global session-list SSE stream.
 * `httpSubscriptionLink` opens one EventSource per subscription, so every
 * consumer (the home page list, the work-complete notifier) registers a handler
 * here instead of subscribing itself. Inert until authenticated.
 */
export function SessionListStreamProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const handlersRef = useRef(new Set<Handler>());

  trpc.sse.onSessionListEvents.useSubscription(undefined, {
    enabled: isAuthenticated,
    onData: (tracked) => {
      for (const handler of handlersRef.current) handler(tracked.data);
    },
    onError: (err) => {
      // tRPC reconnects on its own; consumers resync via useRefetchOnReconnect.
      console.error('Session list stream SSE error:', err);
    },
  });

  const subscribe = useCallback<Subscribe>((handler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  return (
    <SessionListStreamContext.Provider value={subscribe}>
      {children}
    </SessionListStreamContext.Provider>
  );
}

/** Run `handler` for every session-list stream event while the caller is mounted. */
export function useSessionListEvent(handler: Handler): void {
  const subscribe = useContext(SessionListStreamContext);
  if (!subscribe) {
    throw new Error('useSessionListEvent must be used within a SessionListStreamProvider');
  }
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  useEffect(() => subscribe((event) => handlerRef.current(event)), [subscribe]);
}
