import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** A `render` wrapper giving each mounted tree its own QueryClient, so no cache leaks between tests. */
export function QueryClientWrapper({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
