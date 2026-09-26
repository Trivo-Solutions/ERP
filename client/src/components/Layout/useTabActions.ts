import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSnackbar } from 'notistack';
import { MAX_TABS, useTabsStore } from '../../store/tabs.store';
import { ownerOf, splitKey } from './tabPaths';

/**
 * Where the browser actually is right now. Not the router's rendered location: React Router applies
 * navigation as a transition, so on a heavy page useLocation() can trail the URL by a second or more —
 * and a click in that window would wrongly conclude "already there" and skip the navigation.
 */
const currentKey = () => window.location.pathname + window.location.search;

/** Sidebar / tab-strip actions. */
export function useTabActions() {
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();

  /**
   * Sidebar click: go back to the tab already working in that section (exactly as it was left),
   * or open a new one. `forceNew` (Ctrl/Shift/middle-click) always opens a new tab.
   */
  const openPath = useCallback((path: string, forceNew = false) => {
    const s = useTabsStore.getState();
    if (!forceNew) {
      const owner = ownerOf(splitKey(path).pathname);
      const active = s.tabs.find((t) => t.id === s.activeId);
      const existing = active && ownerOf(splitKey(active.key).pathname) === owner
        ? active
        : s.tabs.find((t) => ownerOf(splitKey(t.key).pathname) === owner);
      if (existing) {
        const target = s.focusTab(existing.id, currentKey());
        if (target) navigate(target);
        return;
      }
    }
    if (s.tabs.length >= MAX_TABS) {
      enqueueSnackbar(`${MAX_TABS} tabs are open — close one first`, { variant: 'warning' });
      return;
    }
    s.openTab(path, currentKey());
    if (path !== currentKey()) navigate(path);
  }, [navigate, enqueueSnackbar]);

  const switchTo = useCallback((id: string) => {
    const target = useTabsStore.getState().focusTab(id, currentKey());
    if (target) navigate(target);
  }, [navigate]);

  const closeTab = useCallback((id: string) => {
    const target = useTabsStore.getState().closeTab(id, currentKey());
    if (target) navigate(target);
  }, [navigate]);

  return { openPath, switchTo, closeTab };
}
