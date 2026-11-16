'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { trpc, createTRPCClient } from '@/lib/trpc';
import { AuthProvider } from '@/lib/auth-context';
import { ThemeProvider } from '@/lib/theme-context';
import { SessionListStreamProvider } from '@/lib/session-list-stream-context';
import { AttentionNotifier } from '@/components/AttentionNotifier';
import { PublicLinkLogin } from '@/components/PublicLinkLogin';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() => createTRPCClient());

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          {/* AuthProvider calls auth.logout, so it must sit inside the tRPC and QueryClient providers */}
          <AuthProvider>
            <SessionListStreamProvider>
              <AttentionNotifier />
              <PublicLinkLogin />
              {children}
            </SessionListStreamProvider>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
