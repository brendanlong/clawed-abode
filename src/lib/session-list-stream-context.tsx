'use client';

import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { trpc } from '@/lib/trpc';
import { useAuth } from '@/lib/auth-context';
import type { SessionListStreamEvent } from '@/server/routers/sse';

type Handler = (event: SessionListStreamEvent) => void;
/** Called when the stream errors, so consumers can resync (tRPC reconnects on its own). */
type ErrorHandler = () => void;
type Subscribe = (handler: Handler, onError?: ErrorHandler) => () => void;

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
  const errorHandlersRef = useRef(new Set<ErrorHandler>());

  trpc.sse.onSessionListEvents.useSubscription(undefined, {
    enabled: isAuthenticated,
    onData: (tracked) => {
      for (const handler of handlersRef.current) handler(tracked.data);
    },
    onError: (err) => {
      console.error('Session list stream SSE error:', err);
      for (const handler of errorHandlersRef.current) handler();
    },
  });

  const subscribe = useCallback<Subscribe>((handler, onError) => {
    handlersRef.current.add(handler);
    if (onError) errorHandlersRef.current.add(onError);
    return () => {
      handlersRef.current.delete(handler);
      if (onError) errorHandlersRef.current.delete(onError);
    };
  }, []);

  return (
    <SessionListStreamContext.Provider value={subscribe}>
      {children}
    </SessionListStreamContext.Provider>
  );
}

/**
 * Run `handler` for every session-list stream event while the caller is mounted,
 * and `onError` whenever the stream errors (events may have been missed).
 */
export function useSessionListEvent(handler: Handler, onError?: ErrorHandler): void {
  const subscribe = useContext(SessionListStreamContext);
  if (!subscribe) {
    throw new Error('useSessionListEvent must be used within a SessionListStreamProvider');
  }
  const handlerRef = useRef(handler);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    handlerRef.current = handler;
    onErrorRef.current = onError;
  }, [handler, onError]);
  useEffect(
    () =>
      subscribe(
        (event) => handlerRef.current(event),
        () => onErrorRef.current?.()
      ),
    [subscribe]
  );
}
