import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Box, List, ListItemButton, ListItemIcon, ListItemText,
  Collapse, Typography, Divider, Avatar, Tooltip,
} from '@mui/material';
import {
  DesignServices, ShoppingCart, Inventory2, Assignment, Factory,
  Engineering, Verified, PointOfSale, AccountBalance,
  Dashboard, ExpandLess, ExpandMore, Settings, Logout,
  HardwareOutlined, Assessment, AltRoute, Style, Tune, Calculate,
} from '@mui/icons-material';
import { useAuthStore } from '../../store/auth.store';
import { usePermissions } from '../../hooks/usePermissions';

interface NavItem {
  label: string;
  icon: React.ReactNode;
  path?: string;
  permission?: string;
  children?: Array<{ label: string; path: string; permission?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', icon: <Dashboard />, path: '/', permission: 'report:view' },
  { label: 'Workflow Guide', icon: <AltRoute />, path: '/workflow', permission: 'report:view' },
  {
    label: 'Product Design', icon: <DesignServices />, permission: 'design:view',
    children: [
      { label: 'Design Library', path: '/designs', permission: 'design:view' },
      { label: 'Metal Rates', path: '/designs/rates', permission: 'design:view' },
    ],
  },
  {
    label: 'Procurement', icon: <ShoppingCart />, permission: 'po:view',
    children: [
      { label: 'Purchase Requisitions', path: '/procurement/requisitions', permission: 'po:view' },
      { label: 'Purchase Orders', path: '/procurement/orders', permission: 'po:view' },
      { label: 'GRN Verification', path: '/procurement/grn', permission: 'grn:create' },
      { label: 'Purchase Returns', path: '/procurement/returns', permission: 'po:view' },
      { label: 'Suppliers', path: '/procurement/suppliers', permission: 'po:view' },
    ],
  },
  {
    label: 'Inventory', icon: <Inventory2 />, permission: 'stock:view',
    children: [
      { label: 'Metal Vault', path: '/inventory/metals', permission: 'stock:view' },
      { label: 'Diamond Assortment', path: '/inventory/stones', permission: 'stone:manage' },
      { label: 'Consumables', path: '/inventory/consumables', permission: 'consumable:manage' },
    ],
  },
  {
    label: 'Orders', icon: <Assignment />, permission: 'order:view',
    children: [
      { label: 'Sales Orders', path: '/orders', permission: 'order:view' },
      { label: 'Clients', path: '/orders/clients', permission: 'order:view' },
      { label: 'Reservations', path: '/orders/reservations', permission: 'reservation:manage' },
    ],
  },
  {
    label: 'Manufacturing', icon: <Factory />, permission: 'job:view',
    children: [
      { label: 'Factory Floor', path: '/manufacturing', permission: 'job:view' },
      { label: 'Job Cards', path: '/manufacturing/jobs', permission: 'job:view' },
      { label: 'QC Checkpoints', path: '/manufacturing/qc', permission: 'qc:inspect' },
    ],
  },
  {
    label: 'Outsourcing', icon: <Engineering />, permission: 'karigar:view',
    children: [
      { label: 'Karigar Ledger', path: '/outsourcing/ledger', permission: 'karigar:view' },
      { label: 'Issue / Return', path: '/outsourcing/transactions', permission: 'karigar:issue' },
      { label: 'Sub-Contractor Invoices', path: '/outsourcing/invoices', permission: 'subcon:invoice' },
    ],
  },
  {
    label: 'Quality & Compliance', icon: <Verified />, permission: 'hallmark:manage',
    children: [
      { label: 'Hallmarking', path: '/quality/hallmarking', permission: 'hallmark:manage' },
      { label: 'Repair Jobs', path: '/quality/repairs', permission: 'repair:manage' },
    ],
  },
  {
    label: 'Jewelry Tagging', icon: <Style />, permission: 'tag:view',
    children: [
      { label: 'Tags & Inventory',  path: '/tagging/tags',      permission: 'tag:view' },
      { label: 'Stock Lookup',      path: '/tagging/lookup',    permission: 'tag:view' },
      { label: 'Tag Label Designer', path: '/tagging/templates', permission: 'tagTemplate:manage' },
      { label: 'Branch Stock Summary', path: '/tagging/branch-stock', permission: 'tag:view' },
      { label: 'Stock Audit',       path: '/tagging/audits',    permission: 'stock:view' },
      { label: 'Branches',          path: '/tagging/branches',  permission: 'branch:manage' },
      { label: 'Branch Transfers',  path: '/tagging/transfers', permission: 'branch:transfer' },
    ],
  },
  {
    // Deliberately its own top-level group, not a child of Jewelry Tagging — gated on its own
    // estimation:view permission so a role can get Estimation without Tagging/Inventory access.
    label: 'Estimation', icon: <Calculate />, permission: 'estimation:view',
    children: [
      { label: 'Estimate a Piece', path: '/estimation', permission: 'estimation:view' },
      { label: 'Estimate Templates', path: '/estimation/templates', permission: 'estimateTemplate:manage' },
    ],
  },
  {
    label: 'Sales & Export', icon: <PointOfSale />, permission: 'sales:view',
    children: [
      { label: 'Memo-Out Tracking', path: '/sales/memos', permission: 'memo:manage' },
      { label: 'Sales Invoices', path: '/sales/invoices', permission: 'sales:view' },
      { label: 'Old Gold Exchange', path: '/sales/exchanges', permission: 'sales:view' },
    ],
  },
  {
    label: 'Finance', icon: <AccountBalance />, permission: 'finance:view',
    children: [
      { label: 'Journal Entries', path: '/finance/journals', permission: 'journal:create' },
      { label: 'Chart of Accounts', path: '/finance/accounts', permission: 'finance:view' },
      { label: 'Trial Balance', path: '/finance/trial-balance', permission: 'report:view' },
      { label: 'P&L Statement', path: '/finance/pnl', permission: 'report:view' },
      { label: 'Cost Centers', path: '/finance/cost-centers', permission: 'report:view' },
      { label: 'Dealer Aging', path: '/finance/dealer-aging', permission: 'report:view' },
      { label: 'Client Ledger', path: '/finance/client-ledger', permission: 'report:view' },
      { label: 'Supplier Ledger', path: '/finance/supplier-ledger', permission: 'report:view' },
    ],
  },
  {
    label: 'Reports', icon: <Assessment />, permission: 'report:view',
    children: [
      { label: 'WIP Summary', path: '/reports/wip', permission: 'report:view' },
      { label: 'Stock Summary', path: '/reports/stock', permission: 'report:view' },
      { label: 'Karigar Balances', path: '/reports/karigar', permission: 'report:view' },
      { label: 'Aging Receivables', path: '/reports/aging', permission: 'report:view' },
      { label: 'Sales Register', path: '/reports/sales-register', permission: 'report:view' },
      { label: 'Stock on Hand', path: '/reports/stock-on-hand', permission: 'report:view' },
      { label: 'Dead Stock / Ageing', path: '/reports/dead-stock', permission: 'report:view' },
      { label: 'Day Book', path: '/reports/day-book', permission: 'report:view' },
      { label: 'GST Summary', path: '/reports/gst-summary', permission: 'report:view' },
      { label: 'Purchase GST (ITC)', path: '/reports/purchase-gst-summary', permission: 'report:view' },
    ],
  },
  { label: 'Hardware', icon: <HardwareOutlined />, path: '/hardware', permission: 'hardware:manage' },
  { label: 'Masters', icon: <Tune />, path: '/masters', permission: 'masters:view' },
  { label: 'Settings', icon: <Settings />, path: '/settings', permission: 'system:config' },
];

export function Sidebar({ open }: { open: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { logout, user, company } = useAuthStore();
  const { hasPermission } = usePermissions();
  const [expanded, setExpanded] = useState<string | null>(null);

  const toggle = (label: string) =>
    setExpanded((prev) => (prev === label ? null : label));

  const isActive = (path: string) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);

  return (
    <Box
      sx={{
        width: open ? 260 : 0,
        overflow: 'hidden',
        transition: 'width 0.3s',
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
                  onClick={() => navigate(item.path!)}
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
                          onClick={() => navigate(child.path)}
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
