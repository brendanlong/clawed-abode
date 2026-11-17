'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { trpc, createTRPCClient } from '@/lib/trpc';
import { AuthProvider } from '@/lib/auth-context';
import { ThemeProvider } from '@/lib/theme-context';
import { SessionListStreamProvider } from '@/lib/session-list-stream-context';
import { AttentionNotifier } from '@/components/AttentionNotifier';
import { PublicLinkLogin } from '@/components/PublicLinkLogin';
import { TooltipProvider } from '@/components/ui/tooltip';

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
              <TooltipProvider delayDuration={300}>
                <AttentionNotifier />
                <PublicLinkLogin />
                {children}
              </TooltipProvider>
            </SessionListStreamProvider>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
