import { useCallback } from 'react';
import { useQuery, useQueryClient, QueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { TableLayout } from '../utils/tableLayout';

// The signed-in member's saved table layouts for the current company. Fetched once per session (the shared query
// cache is cleared on every login/logout, so one person's layouts can never render for the next), then kept in the
// cache as the user saves or resets - the server is the source of truth, there is no per-browser copy.
export const TABLE_LAYOUTS_KEY = ['user-table-layouts'] as const;
type LayoutMap = Record<string, TableLayout>;

// Plain functions (not hook-bound) so the cache + request behaviour is testable without a DOM.
export async function saveTableLayout(qc: QueryClient, tableId: string, layout: TableLayout) {
  const res = await api.put(`/user-preferences/table-layouts/${encodeURIComponent(tableId)}`, { layout });
  qc.setQueryData<LayoutMap>(TABLE_LAYOUTS_KEY, (old) => ({ ...(old ?? {}), [tableId]: res.data.data as TableLayout }));
}

// The cache only forgets the layout once the server confirmed the delete - a failed reset leaves both in step.
export async function resetTableLayout(qc: QueryClient, tableId: string) {
  await api.delete(`/user-preferences/table-layouts/${encodeURIComponent(tableId)}`);
  qc.setQueryData<LayoutMap>(TABLE_LAYOUTS_KEY, (old) => {
    const next = { ...(old ?? {}) };
    delete next[tableId];
    return next;
  });
}

export function useSavedTableLayouts() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: TABLE_LAYOUTS_KEY,
    queryFn: async () => (await api.get('/user-preferences/table-layouts')).data.data as LayoutMap,
    staleTime: Infinity,
    retry: 1,
  });

  const save = useCallback((tableId: string, layout: TableLayout) => saveTableLayout(qc, tableId, layout), [qc]);
  const reset = useCallback((tableId: string) => resetTableLayout(qc, tableId), [qc]);

  return { layouts: query.data, isLoaded: query.isSuccess, save, reset };
}
