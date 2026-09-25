import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  darkMode: boolean;
  scaleDevice: string;
  pageTitle: string;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleDarkMode: () => void;
  setScaleDevice: (deviceId: string) => void;
  setPageTitle: (title: string) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      sidebarWidth: 260,
      darkMode: false,
      scaleDevice: 'default-scale',
      pageTitle: '',

      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleDarkMode: () => set((s) => ({ darkMode: !s.darkMode })),
      setScaleDevice: (deviceId) => set({ scaleDevice: deviceId }),
      setPageTitle: (title) => set({ pageTitle: title }),
    }),
    { name: 'sea-erp-ui', partialize: (s) => ({ sidebarOpen: s.sidebarOpen, darkMode: s.darkMode, scaleDevice: s.scaleDevice }) }
  )
);
