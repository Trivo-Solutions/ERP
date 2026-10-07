import React from 'react';
import {
  DesignServices, ShoppingCart, Inventory2, Assignment, Factory,
  Engineering, Verified, PointOfSale, AccountBalance,
  Dashboard, Settings,
  HardwareOutlined, Assessment, AltRoute, Style, Tune, Calculate, People,
} from '@mui/icons-material';

export interface NavItem {
  label: string;
  icon: React.ReactNode;
  path?: string;
  permission?: string;
  children?: Array<{ label: string; path: string; permission?: string }>;
}

export const NAV_ITEMS: NavItem[] = [
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
      // J4-D5: GET /procurement/grn now requires grn:view, not grn:create.
      { label: 'GRN Verification', path: '/procurement/grn', permission: 'grn:view' },
      { label: 'Purchase Returns', path: '/procurement/returns', permission: 'po:view' },
      { label: 'Debit Notes', path: '/procurement/debit-notes', permission: 'debitNote:view' },
      { label: 'Debit Note Templates', path: '/procurement/debit-note-templates', permission: 'debitNoteTemplate:view' },
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
      { label: 'Clients', path: '/orders/clients', permission: 'client:view' },
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
      // Loosened from repair:manage to repair:view — opening the page (viewing repairs) shouldn't
      // require the workflow-action permission; the page's own create/deliver/bill actions still
      // check repair:create/repair:manage individually.
      { label: 'Repair Jobs', path: '/quality/repairs', permission: 'repair:view' },
    ],
  },
  {
    label: 'Jewelry Tagging', icon: <Style />, permission: 'tag:view',
    children: [
      { label: 'Tags & Inventory',  path: '/tagging/tags',      permission: 'tag:view' },
      { label: 'Stock Lookup',      path: '/tagging/lookup',    permission: 'tag:view' },
      { label: 'Jewel Transaction History', path: '/tagging/transactions', permission: 'tag:view' },
      { label: 'Tag Label Designer', path: '/tagging/templates', permission: 'tagTemplate:view' },
      { label: 'Branch Stock Summary', path: '/tagging/branch-stock', permission: 'tag:view' },
      { label: 'Stock Audit',       path: '/tagging/audits',    permission: 'stock:view' },
      { label: 'Branches',          path: '/tagging/branches',  permission: 'branch:create' },
      { label: 'Branch Transfers',  path: '/tagging/transfers', permission: 'branch:transfer' },
      { label: 'Branch Receives',   path: '/tagging/receives',  permission: 'branch:transfer' },
      { label: 'Repair Register',   path: '/tagging/repairs',   permission: 'repair:view' },
      { label: 'Repair Transfers',  path: '/tagging/repair-transfers', permission: 'repair:view' },
    ],
  },
  {
    // Deliberately its own top-level group, not a child of Jewelry Tagging — gated on its own
    // estimation:view permission so a role can get Estimation without Tagging/Inventory access.
    label: 'Estimation', icon: <Calculate />, permission: 'estimation:view',
    children: [
      { label: 'Estimate a Piece', path: '/estimation', permission: 'estimation:view' },
      { label: 'Estimate Templates', path: '/estimation/templates', permission: 'estimateTemplate:view' },
    ],
  },
  {
    label: 'Sales & Export', icon: <PointOfSale />, permission: 'sales:view',
    children: [
      { label: 'Memo-Out Tracking', path: '/sales/memos', permission: 'memo:manage' },
      { label: 'Sales Invoices', path: '/sales/invoices', permission: 'sales:view' },
      { label: 'Material Purchase', path: '/sales/exchanges', permission: 'sales:view' },
      // G1 Part K/L
      { label: 'GST Registrations', path: '/sales/gst-registrations', permission: 'gst:registration_view' },
      // Phase D — AATO + HSN Compliance
      { label: 'GST Compliance & AATO', path: '/sales/gst-compliance', permission: 'gst:registration_view' },
      { label: 'Tax Invoice Templates', path: '/sales/tax-invoice-templates', permission: 'taxInvoiceTemplate:view' },
      // G2d — Credit Notes & Templates
      { label: 'Credit Notes', path: '/sales/credit-notes', permission: 'creditNote:view' },
      { label: 'Credit Note Templates', path: '/sales/credit-note-templates', permission: 'creditNoteTemplate:view' },
    ],
  },
  {
    label: 'Finance', icon: <AccountBalance />, permission: 'finance:view',
    children: [
      { label: 'Journal Entries', path: '/finance/journals', permission: 'journal:create' },
      { label: 'Chart of Accounts', path: '/finance/accounts', permission: 'finance:view' },
      // J4-D1: these six now require report:financial_view on the backend (sensitive financial
      // detail) — Cost Centers stayed on report:view (finance:view actually gates its list route).
      { label: 'Trial Balance', path: '/finance/trial-balance', permission: 'report:financial_view' },
      { label: 'P&L Statement', path: '/finance/pnl', permission: 'report:financial_view' },
      { label: 'Cost Centers', path: '/finance/cost-centers', permission: 'report:view' },
      { label: 'Dealer Aging', path: '/finance/dealer-aging', permission: 'report:financial_view' },
      { label: 'Client Ledger', path: '/finance/client-ledger', permission: 'report:financial_view' },
      { label: 'Supplier Ledger', path: '/finance/supplier-ledger', permission: 'report:financial_view' },
    ],
  },
  {
    label: 'Reports', icon: <Assessment />, permission: 'report:view',
    children: [
      { label: 'WIP Summary', path: '/reports/wip', permission: 'report:view' },
      { label: 'Stock Summary', path: '/reports/stock', permission: 'report:view' },
      { label: 'Karigar Balances', path: '/reports/karigar', permission: 'report:view' },
      // J4-D1: same sensitivity class as Dealer Aging above — requires report:financial_view.
      { label: 'Aging Receivables', path: '/reports/aging', permission: 'report:financial_view' },
      { label: 'Sales Register', path: '/reports/sales-register', permission: 'report:view' },
      { label: 'Sales Report', path: '/reports/sales-report', permission: 'report:view' },
      { label: 'Stock Book', path: '/reports/stock-book', permission: 'report:view' },
      { label: 'Barcode History', path: '/reports/barcode-history', permission: 'report:view' },
      { label: 'Sales Returns', path: '/reports/sales-returns', permission: 'sales:view' },
      { label: 'Repair Register', path: '/reports/repair-register', permission: 'repair:view' },
      { label: 'Repair Transfers', path: '/reports/repair-transfers', permission: 'repair:view' },
      { label: 'Stock on Hand', path: '/reports/stock-on-hand', permission: 'report:view' },
      { label: 'Dead Stock / Ageing', path: '/reports/dead-stock', permission: 'report:view' },
      { label: 'Day Book', path: '/reports/day-book', permission: 'report:financial_view' },
      { label: 'GST Summary', path: '/reports/gst-summary', permission: 'report:financial_view' },
      { label: 'Purchase GST (ITC)', path: '/reports/purchase-gst-summary', permission: 'report:financial_view' },
      { label: 'GSTR-1 Reports', path: '/reports/gstr1', permission: 'report:financial_view' },
      { label: 'GSTR-1 Table 12', path: '/reports/gstr1-table12', permission: 'report:financial_view' },
      { label: 'GSTR-1 Table 13', path: '/reports/gstr1-table13', permission: 'report:financial_view' },
    ],
  },
  { label: 'Hardware', icon: <HardwareOutlined />, path: '/hardware', permission: 'hardware:manage' },
  { label: 'Masters', icon: <Tune />, path: '/masters', permission: 'masters:view' },
  {
    label: 'Management', icon: <People />, permission: 'user:manage',
    children: [
      { label: 'Users', path: '/settings/users', permission: 'user:manage' },
      // J4: role:manage was retired (migration 20260927150000_split_role_manage_permission) and is
      // no longer a valid catalog string — this nav entry was permanently unreachable for every
      // role except a '*' wildcard. role:view mirrors the read-oriented convention used elsewhere.
      { label: 'Roles & Permissions', path: '/settings/roles', permission: 'role:view' },
    ],
  },
  { label: 'Settings', icon: <Settings />, path: '/settings', permission: 'system:config' },
];
