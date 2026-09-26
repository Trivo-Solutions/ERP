import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  /** true: the sidebar always sits beside the page. false: it hides, and slides over the page on demand. */
  sidebarPinned: boolean;
  darkMode: boolean;
  scaleDevice: string;
  pageTitle: string;
  /** The location (pathname + search) `pageTitle` was set for — a title only applies to the page that set it. */
  pageTitleKey: string;
  toggleSidebarPinned: () => void;
  toggleDarkMode: () => void;
  setScaleDevice: (deviceId: string) => void;
  setPageTitle: (title: string, key: string) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarPinned: false,
      darkMode: false,
      scaleDevice: 'default-scale',
      pageTitle: '',
      pageTitleKey: '',

      toggleSidebarPinned: () => set((s) => ({ sidebarPinned: !s.sidebarPinned })),
      toggleDarkMode: () => set((s) => ({ darkMode: !s.darkMode })),
      setScaleDevice: (deviceId) => set({ scaleDevice: deviceId }),
      setPageTitle: (title, key) => set({ pageTitle: title, pageTitleKey: key }),
    }),
    { name: 'sea-erp-ui', partialize: (s) => ({ sidebarPinned: s.sidebarPinned, darkMode: s.darkMode, scaleDevice: s.scaleDevice }) }
  )
);
