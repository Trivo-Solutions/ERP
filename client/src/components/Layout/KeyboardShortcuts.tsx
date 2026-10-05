import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box, Dialog, DialogContent, DialogTitle, List, ListItemButton, ListItemText, TextField, Typography,
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../store/auth.store';
import { useTabsStore } from '../../store/tabs.store';
import { useUiStore } from '../../store/ui.store';
import { NAV_ITEMS } from './navItems';
import { useTabActions } from './useTabActions';

/** Fired by the top-bar button to open the shortcut help. */
export const OPEN_SHORTCUT_HELP_EVENT = 'trivo:open-shortcut-help';
/** The top-bar jewel search input carries this id so Alt+J can focus it. */
export const JEWEL_SEARCH_INPUT_ID = 'jewel-history-search';

// Browser-reserved combos (Ctrl+T/W/N/Tab/1-9) can't be overridden by a page, so tab and page
// shortcuts use Alt. Digits are matched on `code` — Alt+digit changes `key` on some layouts.
export const SHORTCUT_GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: 'Go to',
    items: [
      ['Ctrl + K', 'Command palette — jump to any page by name'],
      ['Alt + N', 'New sale'],
      ['Alt + T', 'New tag'],
      ['Alt + J', 'Jewel history search (top bar)'],
      ['/', "Jump to this page's search / scan box"],
    ],
  },
  {
    title: 'Forms (New Tag, New Sale and every dialog)',
    items: [
      ['Ctrl + S', 'Save / create'],
      ['Ctrl + Enter', 'Next tab — creates on the last tab; after saving, starts the next one'],
      ['Alt + → / Alt + ←', 'Next / previous form tab'],
      ['Alt + D', 'New Sale: discount, charges & tax'],
      ['Alt + P', 'After saving: print the label / invoice'],
    ],
  },
  {
    title: 'Tabs',
    items: [
      ['Alt + 1 … 9', 'Switch to open tab 1–9'],
      ['Alt + PageDown / PageUp', 'Next / previous tab'],
      ['Alt + W', 'Close the current tab'],
    ],
  },
  {
    title: 'Layout & help',
    items: [
      ['Alt + B', 'Pin / auto-hide the sidebar'],
      ['Ctrl + /   or   ?', 'Show this list'],
      ['Esc', 'Close a dialog or the palette'],
    ],
  },
];

interface Command { label: string; group: string; path: string; }

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
};

export function KeyboardShortcuts() {
  const navigate = useNavigate();
  const { openPath, switchTo, closeTab } = useTabActions();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const anyDialog = paletteOpen || helpOpen;

  // Latest values for the one window listener, so it is attached once rather than per render.
  // "New ..." pages aren't sidebar entries: openPath would just refocus the list tab of that section, so
  // reuse a tab already on exactly that page, else open a fresh one.
  const openExact = (path: string) => {
    const existing = useTabsStore.getState().tabs.find((t) => t.key === path);
    if (existing) switchTo(existing.id); else openPath(path, true);
  };
  const live = useRef({ hasPermission, openPath, openExact, switchTo, closeTab, anyDialog });
  live.current = { hasPermission, openPath, openExact, switchTo, closeTab, anyDialog };

  useEffect(() => {
    const open = () => setHelpOpen(true);
    window.addEventListener(OPEN_SHORTCUT_HELP_EVENT, open);
    return () => window.removeEventListener(OPEN_SHORTCUT_HELP_EVENT, open);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { hasPermission: can, openExact, switchTo: sw, closeTab: close, anyDialog: dialog } = live.current;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault(); setHelpOpen(false); setPaletteOpen((o) => !o); return;
      }
      if (mod && !e.altKey && e.key === '/') { e.preventDefault(); setPaletteOpen(false); setHelpOpen(true); return; }
      if (e.key === '?' && !mod && !e.altKey && !dialog && !isTyping(e.target)) { e.preventDefault(); setHelpOpen(true); return; }

      // Ctrl+S / Ctrl+Enter on any screen: press the enabled submit button of the open dialog, else of the
      // page on screen. Pages with their own handling (New Sale, New Tag) already claimed the event.
      if (mod && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === 's' || e.key === 'Enter')) {
        if (e.defaultPrevented) return;
        if (e.key.toLowerCase() === 's') e.preventDefault();   // never the browser's "save page"
        const dialogs = document.querySelectorAll('[role="dialog"]');
        const scope = dialogs.length ? dialogs[dialogs.length - 1] : document.querySelector('[data-tab-pane="active"]');
        const btn = scope?.querySelector<HTMLButtonElement>('button[type="submit"]:not([disabled])');
        if (btn) { e.preventDefault(); btn.click(); }
        return;
      }

      // "/" jumps to the page's search / scan box (not while typing, not under a dialog).
      if (e.key === '/' && !mod && !e.altKey && !dialog && !isTyping(e.target) && !document.querySelector('[role="dialog"]')) {
        const inputs = document.querySelectorAll<HTMLInputElement>('[data-tab-pane="active"] input:not([disabled]):not([type=hidden])');
        const box = Array.from(inputs).find((i) => /search|scan|find/i.test(`${i.placeholder} ${i.getAttribute('aria-label') ?? ''}`) && i.offsetParent !== null);
        if (box) { e.preventDefault(); box.focus(); box.select(); }
        return;
      }

      if (!e.altKey || mod || dialog) return;
      const tabs = () => useTabsStore.getState();

      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) {
        const tab = tabs().tabs[Number(digit[1]) - 1];
        if (tab) { e.preventDefault(); sw(tab.id); }
        return;
      }
      if (e.code === 'PageDown' || e.code === 'PageUp') {
        const { tabs: list, activeId } = tabs();
        if (list.length < 2) return;
        e.preventDefault();
        const i = list.findIndex((t) => t.id === activeId);
        const step = e.code === 'PageDown' ? 1 : -1;
        sw(list[(i + step + list.length) % list.length].id);
        return;
      }
      switch (e.code) {
        case 'KeyW': {
          const { activeId } = tabs();
          if (activeId) { e.preventDefault(); close(activeId); }
          break;
        }
        case 'KeyB': e.preventDefault(); useUiStore.getState().toggleSidebarPinned(); break;
        case 'KeyN': if (can('invoice:create')) { e.preventDefault(); openExact('/sales/invoices/new'); } break;
        case 'KeyT': if (can('tag:create')) { e.preventDefault(); openExact('/tagging/tags/new'); } break;
        case 'KeyJ': {
          const input = document.getElementById(JEWEL_SEARCH_INPUT_ID) as HTMLInputElement | null;
          if (input) { e.preventDefault(); input.focus(); input.select(); }
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [];
    for (const item of NAV_ITEMS) {
      if (item.permission && !hasPermission(item.permission)) continue;
      if (item.path) out.push({ label: item.label, group: '', path: item.path });
      for (const c of item.children ?? []) {
        if (c.permission && !hasPermission(c.permission)) continue;
        out.push({ label: c.label, group: item.label, path: c.path });
      }
    }
    if (hasPermission('invoice:create')) out.push({ label: 'New Sale', group: 'Sales & Export', path: '/sales/invoices/new' });
    if (hasPermission('tag:create')) out.push({ label: 'New Tag', group: 'Jewelry Tagging', path: '/tagging/tags/new' });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteOpen, hasPermission]);

  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const choose = useCallback((path: string, forceNew: boolean) => {
    setPaletteOpen(false);
    if (/\/new$/.test(path)) live.current.openExact(path);
    else live.current.openPath(path, forceNew);
  }, []);

  return (
    <>
      {paletteOpen && <Palette commands={commands} onClose={closePalette} onChoose={choose} />}
      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 16, fontWeight: 700 }}>Keyboard shortcuts</DialogTitle>
        <DialogContent>
          {SHORTCUT_GROUPS.map((g) => (
            <Box key={g.title} sx={{ mb: 1.5 }}>
              <Typography variant="overline" color="text.secondary">{g.title}</Typography>
              {g.items.map(([keys, what]) => (
                <Box key={keys} sx={{ display: 'flex', gap: 1.5, py: 0.4, alignItems: 'baseline' }}>
                  <Box sx={{ width: 190, flexShrink: 0 }}>
                    {keys.split(/\s{2,}or\s{2,}/).map((k, i) => (
                      <Box key={k} component="kbd" sx={{
                        fontFamily: 'inherit', fontSize: 12, px: 0.75, py: 0.1, mr: 0.5, border: '1px solid', borderColor: 'divider',
                        borderRadius: 0.75, bgcolor: 'action.hover', display: 'inline-block', mb: i ? 0 : 0,
                      }}>{k}</Box>
                    ))}
                  </Box>
                  <Typography sx={{ fontSize: 13 }}>{what}</Typography>
                </Box>
              ))}
            </Box>
          ))}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Palette({ commands, onClose, onChoose }: {
  commands: Command[];
  onClose: () => void;
  onChoose: (path: string, forceNew: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return commands;
    return commands
      .filter((c) => { const hay = `${c.group} ${c.label}`.toLowerCase(); return words.every((w) => hay.includes(w)); })
      // label matches before group-only matches
      .sort((a, b) => Number(!a.label.toLowerCase().includes(words[0])) - Number(!b.label.toLowerCase().includes(words[0])));
  }, [q, commands]);

  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => {
    (listRef.current?.children[idx] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[idx];
      if (hit) onChoose(hit.path, e.ctrlKey || e.shiftKey || e.metaKey);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth PaperProps={{ sx: { alignSelf: 'flex-start', mt: '12vh' } }}>
      <Box sx={{ p: 1.5, pb: 0.5 }}>
        <TextField
          autoFocus fullWidth size="small" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
          placeholder="Go to page…  (↑↓ select, ↵ open, Ctrl+↵ new tab)"
          inputProps={{ 'aria-label': 'Command palette' }}
        />
      </Box>
      <List ref={listRef} dense sx={{ maxHeight: 360, overflowY: 'auto', py: 0.5 }}>
        {results.length === 0 && <Typography sx={{ px: 2, py: 1.5, fontSize: 13 }} color="text.secondary">No matching page</Typography>}
        {results.map((c, i) => (
          <ListItemButton
            key={`${c.path}|${c.label}`} selected={i === idx} onMouseMove={() => setIdx(i)}
            onClick={(e) => onChoose(c.path, e.ctrlKey || e.shiftKey || e.metaKey)} tabIndex={-1}
          >
            <ListItemText
              primary={c.label} secondary={c.group || undefined}
              primaryTypographyProps={{ fontSize: 13.5 }} secondaryTypographyProps={{ fontSize: 11.5 }}
            />
          </ListItemButton>
        ))}
      </List>
    </Dialog>
  );
}
