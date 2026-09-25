import React from 'react';
import { Box, AppBar, Toolbar, IconButton, Typography, Badge, Tooltip, Chip } from '@mui/material';
import { Menu as MenuIcon, Notifications, Scale, WifiOff, DarkMode, LightMode } from '@mui/icons-material';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { useUiStore } from '../../store/ui.store';
import { useSocket } from '../../hooks/useSocket';
import { useState, useEffect } from 'react';

const SIDEBAR_WIDTH = 260;

export function AppShell() {
  const { sidebarOpen, toggleSidebar, pageTitle, darkMode, toggleDarkMode } = useUiStore();
  const { socket } = useSocket();
  const [wsConnected, setWsConnected] = useState(false);

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
      {/* Sidebar */}
      <Box
        sx={{
          width: sidebarOpen ? SIDEBAR_WIDTH : 0,
          flexShrink: 0,
          transition: 'width 0.3s ease',
          background: 'linear-gradient(180deg, #0D1B4B 0%, #070D2A 100%)',
          overflow: 'hidden',
          boxShadow: '4px 0 16px rgba(0,0,0,0.2)',
          zIndex: 1200,
        }}
      >
        <Sidebar open={sidebarOpen} />
      </Box>

      {/* Main content */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {/* Top AppBar */}
        <AppBar
          position="static"
          elevation={0}
          sx={{ bgcolor: 'background.paper', borderBottom: '1px solid', borderColor: 'divider', color: 'text.primary' }}
        >
          <Toolbar sx={{ gap: 1, minHeight: '56px !important' }}>
            <IconButton onClick={toggleSidebar} size="small" edge="start">
              <MenuIcon />
            </IconButton>

            <Typography variant="h6" sx={{ flex: 1, fontWeight: 700, color: 'secondary.main', fontSize: 16 }}>
              {pageTitle || 'S.E.A. ERP Suite'}
            </Typography>

            {/* WS Status */}
            <Tooltip title={wsConnected ? 'Real-time connected' : 'Real-time disconnected'}>
              <Chip
                icon={wsConnected ? <Scale fontSize="small" /> : <WifiOff fontSize="small" />}
                label={wsConnected ? 'LIVE' : 'OFFLINE'}
                size="small"
                color={wsConnected ? 'success' : 'error'}
                variant="outlined"
                sx={{ fontSize: 10, height: 24 }}
              />
            </Tooltip>

            <Tooltip title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}>
              <IconButton size="small" onClick={toggleDarkMode}>
                {darkMode ? <LightMode fontSize="small" /> : <DarkMode fontSize="small" />}
              </IconButton>
            </Tooltip>

            <IconButton size="small">
              <Badge badgeContent={3} color="error">
                <Notifications />
              </Badge>
            </IconButton>
          </Toolbar>
        </AppBar>

        {/* Page content */}
        <Box
          sx={{
            flex: 1,
            overflowY: 'auto',
            p: 3,
            bgcolor: 'background.default',
          }}
        >
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}
