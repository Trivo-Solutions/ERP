import { QueryClient } from '@tanstack/react-query';

// Single shared instance — imported by main.tsx (to hand to QueryClientProvider) and by
// auth.store.ts (to clear every cached query on logout/login). Previously created inline inside
// main.tsx with no other module able to reach it, which meant nothing ever cleared it across an
// auth transition: logging out of Company A and logging into Company B in the same tab (no full
// page reload) left up to `staleTime`'s worth of Company A's cached query results (clients,
// stock, invoices, ...) renderable under the same query keys until each one's own background
// refetch happened to land. See auth.store.ts's logout()/setAuth() for the fix.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30 * 1000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});
