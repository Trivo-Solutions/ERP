import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface AppTab {
  id: string;
  /** pathname + search — the tab's own location, independent of which tab is showing. */
  key: string;
}

export const MAX_TABS = 15;

interface TabsState {
  /** company:user the tab list belongs to — a different identity starts from an empty strip. */
  owner: string | null;
  tabs: AppTab[];
  activeId: string | null;
  /** A location we just navigated to on purpose (tab switch/open/close); see syncLocation. Not persisted. */
  pending: string | null;
  /** Bumped when the user deliberately moves to another tab, so the sidebar can open that tab's group. Not persisted. */
  navFocus: { seq: number; key: string };

  bindOwner: (owner: string) => void;
  /** Called on every real location change. Reconciles the strip with where the router actually is. */
  syncLocation: (key: string) => void;
  openTab: (key: string, currentKey: string) => void;
  /** Returns the location to navigate to, or null if already there. */
  focusTab: (id: string, currentKey: string) => string | null;
  /** Returns the location to navigate to (when the closed tab was the active one), else null. */
  closeTab: (id: string, currentKey: string) => string | null;
  setTabKey: (id: string, key: string) => void;
  clearPending: () => void;
  reset: () => void;
}

const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const useTabsStore = create<TabsState>()(
  persist(
    (set, get) => ({
      owner: null,
      tabs: [],
      activeId: null,
      pending: null,
      navFocus: { seq: 0, key: '' },

      bindOwner: (owner) => {
        if (get().owner !== owner) set({ owner, tabs: [], activeId: null, pending: null });
      },

      syncLocation: (key) => {
        const { tabs, activeId, pending } = get();
        // Arrived where an explicit tab action sent us — the active tab is already right.
        if (pending !== null) {
          set({ pending: null });
          if (pending === key) return;
        }
        const active = tabs.find((t) => t.id === activeId);
        if (active?.key === key) return;
        // Landed on a location another tab already holds (browser back/forward, a link to a page that's open): show that tab.
        const other = tabs.find((t) => t.key === key);
        if (other) { set({ activeId: other.id }); return; }
        // Navigation inside the showing tab (a button, a redirect after save): the tab follows.
        if (active) { set({ tabs: tabs.map((t) => (t.id === active.id ? { ...t, key } : t)) }); return; }
        const tab = { id: newId(), key };
        set({ tabs: [...tabs, tab], activeId: tab.id });
      },

      openTab: (key, currentKey) => {
        const tab = { id: newId(), key };
        set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id, pending: key === currentKey ? null : key }));
      },

      focusTab: (id, currentKey) => {
        const tab = get().tabs.find((t) => t.id === id);
        if (!tab) return null;
        set((s) => ({ activeId: id, pending: tab.key === currentKey ? null : tab.key, navFocus: { seq: s.navFocus.seq + 1, key: tab.key } }));
        return tab.key === currentKey ? null : tab.key;
      },

      closeTab: (id, currentKey) => {
        const { tabs, activeId } = get();
        const idx = tabs.findIndex((t) => t.id === id);
        if (idx === -1) return null;
        const rest = tabs.filter((t) => t.id !== id);
        if (id !== activeId) { set({ tabs: rest }); return null; }
        // Closed the one on screen: fall to its right neighbour, else its left; never leave the strip empty.
        const next = rest[Math.min(idx, rest.length - 1)] ?? { id: newId(), key: '/' };
        set((s) => ({
          tabs: rest.length ? rest : [next],
          activeId: next.id,
          pending: next.key === currentKey ? null : next.key,
          navFocus: { seq: s.navFocus.seq + 1, key: next.key },
        }));
        return next.key === currentKey ? null : next.key;
      },

      setTabKey: (id, key) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, key } : t)) })),
      clearPending: () => set({ pending: null }),
      reset: () => set({ owner: null, tabs: [], activeId: null, pending: null }),
    }),
    {
      name: 'trivo-erp-tabs',
      // sessionStorage: a tab strip belongs to this browser tab, and dies with it. Only the locations
      // survive a reload — what was typed into a form lives in memory and is gone after a reload.
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ owner: s.owner, tabs: s.tabs, activeId: s.activeId }),
    },
  ),
);
