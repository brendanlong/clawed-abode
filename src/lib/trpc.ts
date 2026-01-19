'use client';

import { createTRPCReact } from '@trpc/react-query';
import { httpBatchLink, httpSubscriptionLink, splitLink } from '@trpc/client';
import { EventSourcePolyfill } from 'event-source-polyfill';
import superjson from 'superjson';
import type { AppRouter } from '@/server/routers';

export const trpc = createTRPCReact<AppRouter>();

function getBaseUrl() {
  if (typeof window !== 'undefined') {
    return '';
  }
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('auth_token');
}

export function createTRPCClient() {
  return trpc.createClient({
    links: [
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
