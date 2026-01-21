'use client';

import { createTRPCReact, TRPCClientError } from '@trpc/react-query';
import { httpBatchLink, httpSubscriptionLink, splitLink, TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { EventSourcePolyfill } from 'event-source-polyfill';
import superjson from 'superjson';
import type { AppRouter } from '@/server/routers';

export const trpc = createTRPCReact<AppRouter>();

const TOKEN_KEY = 'auth_token';

function getBaseUrl() {
  if (typeof window !== 'undefined') {
    return '';
  }
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Clears the auth token and redirects to login page.
 * Called when we receive an UNAUTHORIZED error from the server.
 */
function handleUnauthorized() {
  if (typeof window === 'undefined') return;

  localStorage.removeItem(TOKEN_KEY);
  // Only redirect if we're not already on the login page
  if (window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
}

/**
 * Custom tRPC link that intercepts UNAUTHORIZED errors and redirects to login.
 */
function authErrorLink(): TRPCLink<AppRouter> {
  return () => {
    return ({ next, op }) => {
      return observable((observer) => {
        const unsubscribe = next(op).subscribe({
          next(value) {
            observer.next(value);
          },
          error(err) {
            if (err instanceof TRPCClientError && err.data?.code === 'UNAUTHORIZED') {
              handleUnauthorized();
            }
            observer.error(err);
          },
          complete() {
            observer.complete();
          },
        });
        return unsubscribe;
      });
    };
  };
}

export function createTRPCClient() {
  return trpc.createClient({
    links: [
      authErrorLink(),
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: httpSubscriptionLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
          EventSource: EventSourcePolyfill,
          eventSourceOptions: async () => {
            const token = getAuthToken();
            if (!token) return {};
            return {
              headers: { authorization: `Bearer ${token}` },
            };
          },
        }),
        false: httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
          headers() {
            const token = getAuthToken();
            return token ? { authorization: `Bearer ${token}` } : {};
          },
        }),
      }),
    ],
  });
}
