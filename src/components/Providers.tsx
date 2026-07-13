'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { trpc, createTRPCClient } from '@/lib/trpc';
import { AuthProvider } from '@/lib/auth-context';
import { WorkingProvider } from '@/lib/working-context';
import { ThemeProvider } from '@/lib/theme-context';
import { WorkCompleteNotifier } from '@/components/WorkCompleteNotifier';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() => createTRPCClient());

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            <WorkingProvider>
              <WorkCompleteNotifier />
              {children}
            </WorkingProvider>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
