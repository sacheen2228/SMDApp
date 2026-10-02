'use client';

import { QueryClient, QueryClientProvider as TanStackQueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function QueryClientProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10000,
            // Live dashboard: refetch when the user returns to the tab and
            // keep interval polling alive in background tabs (system-on
            // auto-update — background timers may still be throttled ~1/min
            // by the browser, which is fine for market data cadence).
            refetchOnWindowFocus: true,
            refetchIntervalInBackground: true,
            retry: 2,
          },
        },
      })
  );

  return (
    <TanStackQueryClientProvider client={queryClient}>{children}</TanStackQueryClientProvider>
  );
}
