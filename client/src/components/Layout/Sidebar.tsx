import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Box, List, ListItemButton, ListItemIcon, ListItemText,
  Collapse, Typography, Divider, Avatar, Tooltip,
} from '@mui/material';
import { ExpandLess, ExpandMore, Logout } from '@mui/icons-material';
import { useAuthStore } from '../../store/auth.store';
import { usePermissions } from '../../hooks/usePermissions';
import { NAV_ITEMS } from './navItems';
import { useTabsStore } from '../../store/tabs.store';
import { ownerOf, splitKey } from './tabPaths';
import { useTabActions } from './useTabActions';

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  const { openPath } = useTabActions();
  const { logout, user, company } = useAuthStore();
  const { hasPermission } = usePermissions();
  const [expanded, setExpanded] = useState<string | null>(null);

  // The navFocus event the user had last seen when they last opened/closed a group by hand — that group
  // choice wins over the event, however late React gets round to rendering it.
  const toggledAtSeq = useRef(0);
  const toggle = (label: string) => {
    toggledAtSeq.current = useTabsStore.getState().navFocus.seq;
    setExpanded((prev) => (prev === label ? null : label));
  };

  // A page opened from inside another page (New Tag, a ledger for one client) still lights up the
  // sidebar entry it belongs to.
  const activeOwner = ownerOf(location.pathname);
  const isActive = (path: string) => path === activeOwner;

  // Switching to another tab (tab strip click, closing the tab you were on) opens the group that tab lives in.
  // Not tied to the URL: React Router applies location changes as transitions, so on a heavy page the sidebar
  // can see the new URL a second late — long enough to overwrite a group the user has just clicked.
  const navFocus = useTabsStore((s) => s.navFocus);
  useEffect(() => {
    if (navFocus.seq === 0 || toggledAtSeq.current === navFocus.seq) return;
    const owner = ownerOf(splitKey(navFocus.key).pathname);
    const group = NAV_ITEMS.find((i) => i.children?.some((c) => c.path === owner));
    if (group) setExpanded(group.label);
  }, [navFocus]);

  // Click = the tab already working in that section (or a new one); Ctrl/Shift/middle-click = always a new tab.
  // Picking a page also tells the shell, which hides an auto-hide sidebar.
  const go = (path: string) => (e: React.MouseEvent) => { openPath(path, e.ctrlKey || e.shiftKey || e.metaKey); onNavigate?.(); };
  const goNew = (path: string) => (e: React.MouseEvent) => {
    if (e.button === 1) { e.preventDefault(); openPath(path, true); onNavigate?.(); }
  };

  return (
    <Box
      sx={{
        width: 260,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      {/* Logo */}
      <Box sx={{ p: 2.5, display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Box component="img" src="/logo.png" alt="Trivo" sx={{ width: 36, height: 36, objectFit: 'contain', filter: 'brightness(0) invert(1)' }} />
        <Box>
          <Typography variant="subtitle2" sx={{ color: '#FFFFFF', fontWeight: 700, lineHeight: 1 }}>
            TRIVO ERP
          </Typography>
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 10 }}>
            {company?.name ?? 'Jewelry Suite'}
          </Typography>
        </Box>
      </Box>

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />

      {/* Navigation */}
      <Box sx={{ flex: 1, overflowY: 'auto', py: 1 }}>
        <List dense disablePadding>
          {NAV_ITEMS.map((item) => {
            if (item.permission && !hasPermission(item.permission)) return null;

            if (item.path) {
              return (
                <ListItemButton
                  key={item.label}
                  selected={isActive(item.path)}
                  onClick={go(item.path!)}
                  onAuxClick={goNew(item.path!)}
                >
                  <ListItemIcon sx={{ color: isActive(item.path) ? '#44C47A' : 'rgba(255,255,255,0.6)', minWidth: 36 }}>
                    {item.icon}
                  </ListItemIcon>
                  <ListItemText
                    primary={item.label}
                    primaryTypographyProps={{ fontSize: 13, fontWeight: isActive(item.path) ? 700 : 400, color: isActive(item.path) ? '#44C47A' : 'rgba(255,255,255,0.85)' }}
                  />
                </ListItemButton>
              );
            }

            const isOpen = expanded === item.label;
            const hasActiveChild = item.children?.some((c) => isActive(c.path));

            return (
              <React.Fragment key={item.label}>
                <ListItemButton onClick={() => toggle(item.label)}>
                  <ListItemIcon sx={{ color: hasActiveChild ? '#44C47A' : 'rgba(255,255,255,0.6)', minWidth: 36 }}>
                    {item.icon}
                  </ListItemIcon>
                  <ListItemText
                    primary={item.label}
                    primaryTypographyProps={{ fontSize: 13, fontWeight: hasActiveChild ? 700 : 400, color: hasActiveChild ? '#44C47A' : 'rgba(255,255,255,0.85)' }}
                  />
                  {isOpen ? <ExpandLess sx={{ color: 'rgba(255,255,255,0.4)', fontSize: 18 }} /> : <ExpandMore sx={{ color: 'rgba(255,255,255,0.4)', fontSize: 18 }} />}
                </ListItemButton>
                <Collapse in={isOpen} timeout="auto">
                  <List dense disablePadding>
                    {item.children?.map((child) => {
                      if (child.permission && !hasPermission(child.permission)) return null;
                      return (
                        <ListItemButton
                          key={child.path}
                          selected={isActive(child.path)}
                          onClick={go(child.path)}
                          onAuxClick={goNew(child.path)}
                          sx={{ pl: 5.5 }}
                        >
                          <ListItemText
                            primary={child.label}
                            primaryTypographyProps={{
                              fontSize: 12.5,
                              fontWeight: isActive(child.path) ? 600 : 400,
                              color: isActive(child.path) ? '#44C47A' : 'rgba(255,255,255,0.7)',
                            }}
                          />
                        </ListItemButton>
                      );
                    })}
                  </List>
                </Collapse>
              </React.Fragment>
            );
          })}
        </List>
      </Box>

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />

      {/* User info */}
      <Box sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Avatar sx={{ width: 32, height: 32, bgcolor: '#44C47A', fontSize: 14, fontWeight: 700 }}>
          {user?.name?.[0]?.toUpperCase()}
        </Avatar>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ color: '#FFF', fontSize: 12.5, fontWeight: 600 }} noWrap>
            {user?.name}
          </Typography>
          <Typography sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }} noWrap>
            {user?.role}{company?.code ? ` · ${company.code}` : ''}
          </Typography>
        </Box>
        <Tooltip title="Logout">
          <Logout
            sx={{ color: 'rgba(255,255,255,0.4)', fontSize: 18, cursor: 'pointer', '&:hover': { color: '#FF6B6B' } }}
            onClick={logout}
          />
        </Tooltip>
      </Box>
    </Box>
  );
}
