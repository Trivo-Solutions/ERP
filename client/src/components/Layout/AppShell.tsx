import React from 'react';
import { Box, AppBar, Toolbar, IconButton, Typography, Badge, Tooltip, Chip, TextField, InputAdornment } from '@mui/material';
import { Notifications, Scale, WifiOff, DarkMode, LightMode, Search, KeyboardOutlined } from '@mui/icons-material';
import { useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';
import { SidebarToggleIcon } from './SidebarToggleIcon';
import { titleOf } from './tabPaths';
import { TabPane } from './TabPane';
import { KeyboardShortcuts, OPEN_SHORTCUT_HELP_EVENT, JEWEL_SEARCH_INPUT_ID } from './KeyboardShortcuts';
import { useTabsStore } from '../../store/tabs.store';
import { useAuthStore } from '../../store/auth.store';
import { useUiStore } from '../../store/ui.store';
import { useSocket } from '../../hooks/useSocket';
import { useState, useEffect, useRef, useCallback } from 'react';

const JEWEL_HISTORY_PATH = '/tagging/transactions';
const SIDEBAR_WIDTH = 260;
const EDGE_WIDTH = 6;         // px of the left screen edge that reveals the hidden sidebar
const REVEAL_DELAY_MS = 120;  // linger at the edge this long, so reaching for the first tab doesn't open it
const HIDE_DELAY_MS = 250;    // grace after the pointer leaves, so a brief slip doesn't slam it shut

export function AppShell() {
  const { sidebarPinned, toggleSidebarPinned, pageTitle, pageTitleKey, darkMode, toggleDarkMode } = useUiStore();
  const { socket } = useSocket();
  const [wsConnected, setWsConnected] = useState(false);

  // Auto-hide mode: the sidebar slides over the page (no reflow) while the pointer is at the left
  // edge or on the sidebar, and hides again after a page is picked or the pointer leaves.
  const [peek, setPeek] = useState(false);
  const timer = useRef<number>();
  const later = useCallback((show: boolean, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPeek(show), ms);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const hideNow = useCallback(() => { window.clearTimeout(timer.current); setPeek(false); }, []);
  useEffect(() => { if (sidebarPinned) hideNow(); }, [sidebarPinned, hideNow]);
  useEffect(() => {
    if (!peek) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hideNow(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [peek, hideNow]);

  // Open pages. The tab list belongs to one company+user; a different identity (logout, another
  // company logging in over this one) starts empty and its panes are unmounted, so nothing typed
  // into one session can show up in the next.
  const location = useLocation();
  const locationKey = location.pathname + location.search;
  const identity = useAuthStore((s) => (s.company?.id && s.user?.id ? `${s.company.id}:${s.user.id}` : null));
  const tabsOwner = useTabsStore((s) => s.owner);
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);

  useEffect(() => {
    if (identity) useTabsStore.getState().bindOwner(identity);
    else useTabsStore.getState().reset();
  }, [identity]);

  // Effects run in order: the owner is bound before the first location is reconciled.
  useEffect(() => {
    if (identity) useTabsStore.getState().syncLocation(locationKey);
  }, [identity, locationKey]);

  // Top-bar jewel search. Reuses an open history tab (pointing it at the new tag) instead of letting the tab you
  // are on follow the navigation, or opens one; either way the page reads the tag from `?q=`.
  const navigate = useNavigate();
  const canViewTags = useAuthStore((s) => s.hasPermission('tag:view'));
  const [jewelQuery, setJewelQuery] = useState('');
  const openJewelHistory = () => {
    const q = jewelQuery.trim();
    if (!q) return;
    const key = `${JEWEL_HISTORY_PATH}?q=${encodeURIComponent(q)}`;
    const store = useTabsStore.getState();
    const existing = store.tabs.find((t) => t.key.split('?')[0] === JEWEL_HISTORY_PATH);
    let go: string | null;
    if (existing) {
      store.setTabKey(existing.id, key);
      go = store.focusTab(existing.id, locationKey);
    } else {
      store.openTab(key, locationKey);
      go = key === locationKey ? null : key;
    }
    if (go) navigate(go);
    setJewelQuery('');
  };

  useEffect(() => {
    if (!socket) return;
    const onConnect = () => setWsConnected(true);
    const onDisconnect = () => setWsConnected(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    setWsConnected(socket.connected);
    return () => { socket.off('connect', onConnect); socket.off('disconnect', onDisconnect); };
  }, [socket]);

  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <KeyboardShortcuts />
      {/* Sidebar — pinned: beside the page. Auto-hide: hidden, revealed from the left edge. */}
      {!sidebarPinned && (
        <Box
          aria-hidden
          onMouseEnter={(e) => { if (e.buttons === 0) later(true, REVEAL_DELAY_MS); }}
          onMouseLeave={() => { if (!peek) window.clearTimeout(timer.current); }}
          sx={{ position: 'fixed', top: 0, left: 0, bottom: 0, width: EDGE_WIDTH, zIndex: 1250 }}
        />
      )}
      <Box
        onMouseEnter={() => { if (!sidebarPinned) window.clearTimeout(timer.current); }}
        onMouseLeave={() => { if (!sidebarPinned) later(false, HIDE_DELAY_MS); }}
        sx={{
          ...(sidebarPinned
            ? { width: SIDEBAR_WIDTH, flexShrink: 0 }
            : {
                position: 'fixed', top: 0, left: 0, bottom: 0, width: SIDEBAR_WIDTH, zIndex: 1250,
                transform: peek ? 'translateX(0)' : `translateX(-${SIDEBAR_WIDTH}px)`,
                // hidden = unfocusable and unclickable, but only once it has finished sliding out
                visibility: peek ? 'visible' : 'hidden',
                transition: peek ? 'transform 0.18s ease' : 'transform 0.18s ease, visibility 0s linear 0.18s',
              }),
          background: 'linear-gradient(180deg, #0D1B4B 0%, #070D2A 100%)',
          overflow: 'hidden',
          boxShadow: sidebarPinned || peek ? '4px 0 16px rgba(0,0,0,0.2)' : 'none',
        }}
      >
        <Sidebar onNavigate={hideNow} />
      </Box>

      {/* Main content */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {/* Top AppBar */}
        <AppBar
          position="static"
          elevation={0}
          sx={{ bgcolor: 'background.paper', borderBottom: '1px solid', borderColor: 'divider', color: 'text.primary' }}
        >
          <Toolbar disableGutters sx={{ gap: 0.75, px: 1.5, minHeight: '40px !important' }}>
            <Tooltip title={sidebarPinned ? 'Sidebar pinned — click to auto-hide' : 'Sidebar auto-hides — click to pin it open'}>
              <IconButton
                onClick={toggleSidebarPinned}
                size="small"
                edge="start"
                sx={{ p: 0.5 }}
                aria-label="Pin sidebar"
                aria-pressed={sidebarPinned}
                color={sidebarPinned ? 'primary' : 'default'}
              >
                <SidebarToggleIcon filled={sidebarPinned} sx={{ fontSize: 20 }} />
              </IconButton>
            </Tooltip>

            <Typography variant="h6" noWrap sx={{ flex: 1, minWidth: 0, fontWeight: 700, color: 'secondary.main', fontSize: 14, lineHeight: 1.2 }}>
              {pageTitleKey === locationKey ? pageTitle : titleOf(location.pathname)}
            </Typography>

            {/* Jewel history quick search: type / scan a tag number, Enter opens its transaction history. */}
            {canViewTags && (
              <TextField
                size="small"
                value={jewelQuery}
                onChange={(e) => setJewelQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); openJewelHistory(); } }}
                placeholder="Jewel history — tag no. ↵"
                inputProps={{ id: JEWEL_SEARCH_INPUT_ID, 'aria-label': 'Jewel transaction history search', style: { padding: '3px 6px', fontSize: 12.5 } }}
                InputProps={{ startAdornment: <InputAdornment position="start" sx={{ mr: 0.25 }}><Search sx={{ fontSize: 16 }} /></InputAdornment> }}
                sx={{ width: 210, '& .MuiOutlinedInput-root': { pl: 0.75 } }}
              />
            )}

            {/* WS Status */}
            <Tooltip title={wsConnected ? 'Real-time connected' : 'Real-time disconnected'}>
              <Chip
                icon={wsConnected ? <Scale sx={{ fontSize: '14px !important' }} /> : <WifiOff sx={{ fontSize: '14px !important' }} />}
                label={wsConnected ? 'LIVE' : 'OFFLINE'}
                size="small"
                color={wsConnected ? 'success' : 'error'}
                variant="outlined"
                sx={{ fontSize: 9.5, height: 20, '& .MuiChip-label': { px: 0.75 } }}
              />
            </Tooltip>

            <Tooltip title="Keyboard shortcuts (Ctrl+/) · Command palette (Ctrl+K)">
              <IconButton size="small" onClick={() => window.dispatchEvent(new Event(OPEN_SHORTCUT_HELP_EVENT))} sx={{ p: 0.5 }} aria-label="Keyboard shortcuts">
                <KeyboardOutlined sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>

            <Tooltip title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}>
              <IconButton size="small" onClick={toggleDarkMode} sx={{ p: 0.5 }}>
                {darkMode ? <LightMode sx={{ fontSize: 18 }} /> : <DarkMode sx={{ fontSize: 18 }} />}
              </IconButton>
            </Tooltip>

            <IconButton size="small" sx={{ p: 0.5 }}>
              <Badge badgeContent={3} color="error" sx={{ '& .MuiBadge-badge': { fontSize: 9, height: 14, minWidth: 14, px: 0.4 } }}>
                <Notifications sx={{ fontSize: 18 }} />
              </Badge>
            </IconButton>
          </Toolbar>
          <TabBar />
        </AppBar>

        {/* Page content — one pane per open tab, all kept mounted; only the active one is visible */}
        <Box sx={{ flex: 1, position: 'relative', overflow: 'hidden', bgcolor: 'background.default' }}>
          {identity && tabsOwner === identity && tabs.map((tab) => (
            <TabPane key={`${identity}:${tab.id}`} id={tab.id} tabKey={tab.key} active={tab.id === activeId} />
          ))}
        </Box>
      </Box>
    </Box>
  );
}
