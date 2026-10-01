import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { queryClient } from '../api/queryClient';
import { closeSocket } from '../api/socketRegistry';
import { useTabsStore } from './tabs.store';

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  permissions: string[];
  department?: string;
  companyUserId?: string;
  branchAccess?: {
    allBranches: boolean;
    branchIds: string[];
  };
}

// Display-only — which tenant this session's JWT was issued for. The backend embeds companyId
// in the token itself and derives tenant context from that on every request; this is never sent
// back to the API as a selector (see server's rejectClientTenantSelectors).
interface Company {
  id: string;
  code: string;
  name: string;
}

interface AuthState {
  user: User | null;
  company: Company | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  setAuth: (user: User, accessToken: string, refreshToken: string, company: Company) => void;
  setAccessToken: (token: string) => void;
  logout: () => void;
  hasPermission: (permission: string) => boolean;
  hasAnyPermission: (...permissions: string[]) => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      company: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,

      setAuth: (user, accessToken, refreshToken, company) => {
        // Clear every cached query BEFORE swapping the session in — a login (fresh session, or a
        // different company logging in over an old one in the same tab) must never let a
        // component render a still-mounted query's stale cached data from the previous session,
        // even for the instant before its own fetch resolves. See api/queryClient.ts.
        queryClient.clear();
        closeSocket(); // the previous session's realtime connection must not survive into this one
        useTabsStore.getState().reset(); // …nor its open-page tabs
        set({ user, company, accessToken, refreshToken, isAuthenticated: true });
      },

      setAccessToken: (token) => set({ accessToken: token }),

      logout: () => {
        // Same reasoning as setAuth — a logged-out session must leave nothing behind for
        // whoever logs in next in this tab (a different user, a different company, or even a
        // re-login of the same user) to accidentally render before their own fetches land.
        queryClient.clear();
        closeSocket();
        useTabsStore.getState().reset();
        set({ user: null, company: null, accessToken: null, refreshToken: null, isAuthenticated: false });
      },

      hasPermission: (permission) => {
        const { user } = get();
        if (!user) return false;
        return (
          user.permissions.includes('*') ||
          user.permissions.includes(permission) ||
          user.permissions.includes(`${permission.split(':')[0]}:*`)
        );
      },

      hasAnyPermission: (...permissions) => {
        const { hasPermission } = get();
        return permissions.some((p) => hasPermission(p));
      },
    }),
    {
      name: 'sea-erp-auth',
      partialize: (state) => ({
        user: state.user,
        company: state.company,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);

// Cross-tab sync: zustand's persist middleware only reads localStorage once, on that tab's own
// initial load — it does NOT react to another tab changing the same key. Without this, logging
// out (or switching companies) in tab 1 leaves tab 2 running indefinitely on its old in-memory
// session (still-valid access token, still-rendered UI) until that token happens to expire.
// window's storage event fires in every OTHER tab (never the one that made the write), so this
// listener re-syncs this tab's store — and drops any of this tab's cached query data — the
// moment another tab's auth state changes underneath it, whichever direction that change goes.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== 'sea-erp-auth') return;
    useAuthStore.persist.rehydrate();
    queryClient.clear();
    closeSocket(); // another tab changed the session (logout / different company): drop this tab's old connection
  });
}
