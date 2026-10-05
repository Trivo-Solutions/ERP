import { useEffect, useRef } from 'react';
import { useTabActive } from '../components/Layout/TabActiveContext';

/**
 * Page-level shortcuts, e.g. `{ 'ctrl+s': save, 'alt+arrowright': next }`.
 * Combo = optional `ctrl+`/`alt+`/`shift+` prefixes (ctrl also matches Cmd) + `event.key` lowercased.
 *
 * - Fires only while this page's tab is the one on screen (background tabs stay mounted).
 * - Suspended while a dialog is open, so a page never acts underneath a modal.
 * - Runs in the capture phase and calls preventDefault, so the app-wide fallbacks in
 *   KeyboardShortcuts (which skip a defaultPrevented event) never double-handle the key.
 */
export function usePageShortcuts(map: Record<string, ((e: KeyboardEvent) => void) | undefined>) {
  const active = useTabActive();
  const live = useRef({ map, active });
  live.current = { map, active };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { map: m, active: on } = live.current;
      if (!on || e.repeat || document.querySelector('[role="dialog"]')) return;
      const combo = `${e.ctrlKey || e.metaKey ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${e.key.toLowerCase()}`;
      const fn = m[combo];
      if (!fn) return;
      e.preventDefault();
      fn(e);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

/** After a wizard-style tab change: put the cursor in the first field of the new tab. */
export function focusFirstField(form: HTMLElement | null) {
  window.setTimeout(() => {
    const el = Array.from(form?.querySelectorAll<HTMLElement>('input:not([type=hidden]):not([disabled]), textarea:not([disabled])') ?? [])
      .find((x) => !x.closest('.MuiTabs-root') && x.offsetParent !== null);
    el?.focus();
  }, 60);
}
