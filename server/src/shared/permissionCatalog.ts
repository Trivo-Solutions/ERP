// The catalog behind the Role editor's permission grid (client: Settings > Roles). Each row is a
// real feature already gated somewhere in the app by requirePermission(...); each capability is
// one of THIS app's actual permission strings — never a fabricated action. Unlike a uniform
// Add/Edit/Delete/View/Export grid, a row only carries the capabilities that feature actually has
// (e.g. GRN has Create/Verify, not a generic CRUD set) — no permission is invented to fill a cell,
// and no server-side requirePermission(...) check anywhere needs to change: editing a role here
// still just writes to Role.permissions, exactly as the old plain-text POST /settings/roles did.
//
// Keep this in sync with requirePermission(...) call sites across server/src/modules — there is
// no automated check that every enforced string appears here (a missing one is simply ungrantable
// from the UI, not a security hole; an extra one here that nothing enforces is inert).

export interface PermissionCapability { action: string; permission: string; enforced?: false }
export interface PermissionCatalogItem { key: string; label: string; capabilities: PermissionCapability[] }
export interface PermissionCatalogGroup { label: string; items: PermissionCatalogItem[] }

const ACTION_LABELS: Record<string, string> = {
  view: 'View', create: 'Create', edit: 'Edit', update: 'Update', manage: 'Manage', delete: 'Delete',
  adjust: 'Adjust', approve: 'Approve', split: 'Split', issue: 'Issue', return: 'Return',
  verify: 'Verify', inspect: 'Inspect', post: 'Post', transfer: 'Transfer', doc: 'Export',
  config: 'Configure', estimate: 'Estimate', invoice: 'Invoice',
  deactivate: 'Deactivate/Reactivate', void: 'Void', reverse: 'Reverse', cancel: 'Cancel',
  // J4: split out of a broader existing action (report:view, po:approve) — kept as its own label
  // rather than folded into the existing one so the Role Editor shows it as a distinct grant.
  financial_view: 'View (Financial Detail)', approve_high_value: 'Approve (High Value, >₹5,00,000)',
  // G1: GST registration is its own resource (gst:registration_*) — the action segment carries an
  // underscore, which starterPackage/validate.ts's permission-string regex already accommodates
  // (widened for J4-D1's report:financial_view/po:approve_high_value, same shape here).
  registration_view: 'View', registration_create: 'Create', registration_edit: 'Edit', registration_manage: 'Manage (Activate/Assign to Branch)',
  // G2g-6a: statutory filing-period persistence foundation (CLAUDE.md's G2g-6a entry) — schema only,
  // no snapshot/filing service exists yet, same underscore-action shape as registration_* above.
  period_view: 'View', snapshot_create: 'Create Snapshot', snapshot_export: 'Export Snapshot', filing_record: 'Record Filing',
  // G8a: GST Integration Foundation (config for a future e-invoice/IRP/E-Way Bill provider) —
  // same underscore-action shape as registration_*/period_view above.
  // Returned-jewellery pipeline: a branch sends a returned piece to HO; HO receives, inspects/repairs, retags.
  send: 'Send to HO', receive: 'Receive at HO', work: 'Repair Work', reprint: 'Reprint Tag',
  integration_view: 'View', integration_manage: 'Manage (Configure/Credentials)', integration_test: 'Test Connection',
  // Photography (Phase 2: routes in modules/photography enforce view/capture/delete; review/restore/manage_* are not yet used). Same underscore-action shape as above.
  capture: 'Capture', review: 'Review/Approve', restore: 'Restore', manage_stations: 'Manage Stations', manage_cameras: 'Manage Cameras', manage_settings: 'Manage Settings',
};

function cap(permission: string): PermissionCapability {
  const action = permission.split(':')[1] ?? permission;
  return { action: ACTION_LABELS[action] ?? action, permission };
}

export const PERMISSION_CATALOG: PermissionCatalogGroup[] = [
  {
    label: 'General', items: [
      // The dashboard (and Workflow Guide) only. Each report is its own row in the Reports group below.
      { key: 'dashboard', label: 'Dashboard', capabilities: [cap('report:view')] },
      { key: 'audit', label: 'Audit Log', capabilities: [cap('audit:view')] },
    ],
  },
  {
    label: 'Reports', items: [
      // Each report is its own grant (View). Split out of report:view (operational) and
      // report:financial_view (financial); migration 20261014100000_split_report_permissions gave every
      // existing role the new strings matching what it could already open.
      { key: 'rptStock', label: 'Stock Summary', capabilities: [cap('report:stock_summary')] },
      { key: 'rptStockBook', label: 'Stock Book', capabilities: [cap('report:stock_book')] },
      { key: 'rptStockOnHand', label: 'Stock on Hand', capabilities: [cap('report:stock_on_hand')] },
      { key: 'rptDeadStock', label: 'Dead Stock / Ageing', capabilities: [cap('report:dead_stock')] },
      { key: 'rptBarcode', label: 'Barcode History', capabilities: [cap('report:barcode_history')] },
      { key: 'rptSalesRegister', label: 'Sales Register', capabilities: [cap('report:sales_register')] },
      { key: 'rptSalesReport', label: 'Sales Report (Summary / Detailed)', capabilities: [cap('report:sales_report')] },
      { key: 'rptWip', label: 'WIP Summary', capabilities: [cap('report:wip')] },
      { key: 'rptKarigar', label: 'Karigar Balances', capabilities: [cap('report:karigar')] },
      { key: 'rptCostCenters', label: 'Cost Centers', capabilities: [cap('report:cost_centers')] },
      { key: 'rptTrialBalance', label: 'Trial Balance', capabilities: [cap('report:trial_balance')] },
      { key: 'rptPnl', label: 'P&L Statement', capabilities: [cap('report:pnl')] },
      { key: 'rptBalanceSheet', label: 'Balance Sheet', capabilities: [cap('report:balance_sheet')] },
      { key: 'rptDayBook', label: 'Day Book', capabilities: [cap('report:day_book')] },
      { key: 'rptDealerAging', label: 'Dealer Aging', capabilities: [cap('report:dealer_aging')] },
      { key: 'rptAgingReceivables', label: 'Aging Receivables', capabilities: [cap('report:aging_receivables')] },
      { key: 'rptClientLedger', label: 'Client Ledger', capabilities: [cap('report:client_ledger')] },
      { key: 'rptSupplierLedger', label: 'Supplier Ledger', capabilities: [cap('report:supplier_ledger')] },
      // The statutory family (GST summaries, ITC, GSTR-1 / 3B / 2B, RCM) stays one grant: those routes are frozen.
      { key: 'financialReports', label: 'GST & Statutory Reports (GST Summary, ITC, GSTR-1/3B/2B)', capabilities: [cap('report:financial_view')] },
    ],
  },
  {
    label: 'Product Design', items: [
      { key: 'design', label: 'Design Library / Metal Rates', capabilities: [cap('design:view'), cap('design:create'), cap('design:edit')] },
      // Entering / changing the daily gold & silver rates - the one LIVE element of every sale price, so it is its own grant (not system:config).
      { key: 'metalRate', label: 'Daily Metal Rates (enter / change)', capabilities: [cap('rate:update')] },
      { key: 'bom', label: 'Bill of Materials', capabilities: [cap('bom:manage')] },
      { key: 'cost', label: 'Cost Estimation', capabilities: [cap('cost:estimate')] },
    ],
  },
  {
    label: 'Procurement', items: [
      {
        key: 'po', label: 'Purchase Orders',
        // J4-D2: the >₹5,00,000 threshold is now a permission, not a hardcoded role-name check
        // (see approvePO in procurement.service.ts) — po:approve_high_value is required IN ADDITION
        // to po:approve, never instead of it.
        capabilities: [cap('po:view'), cap('po:create'), cap('po:approve'), cap('po:approve_high_value')],
      },
      // Supplier master. view/create also keep working through po:view/po:create (see procurement.router.ts).
      {
        key: 'supplier', label: 'Suppliers',
        capabilities: [cap('supplier:view'), cap('supplier:create'), cap('supplier:edit'), cap('supplier:deactivate'), cap('supplier:delete')],
      },
      // Money paid out to suppliers. view/create also work via po:view / journal:create (the older gates).
      {
        key: 'supplierPayment', label: 'Supplier Payments',
        capabilities: [cap('supplierPayment:view'), cap('supplierPayment:create'), cap('supplierPayment:reverse')],
      },
      // J4-D5: grn:view is new — GET /procurement/grn used to ride the create permission.
      { key: 'grn', label: 'GRN Verification', capabilities: [cap('grn:view'), cap('grn:create'), cap('grn:verify')] },
    ],
  },
  {
    label: 'Inventory', items: [
      { key: 'stock', label: 'Stock', capabilities: [cap('stock:view'), cap('stock:adjust')] },
      { key: 'stone', label: 'Diamond / Stone Assortment', capabilities: [cap('stone:manage'), cap('stone:split')] },
      { key: 'consumable', label: 'Consumables', capabilities: [cap('consumable:manage')] },
    ],
  },
  {
    label: 'Orders (Production)', items: [
      { key: 'order', label: 'Sales Orders (production)', capabilities: [cap('order:view'), cap('order:create'), cap('order:approve')] },
      { key: 'reservation', label: 'Reservations', capabilities: [cap('reservation:manage')] },
    ],
  },
  {
    label: 'Manufacturing', items: [
      { key: 'job', label: 'Job Cards / Factory Floor', capabilities: [cap('job:view'), cap('job:create'), cap('job:update')] },
      { key: 'wip', label: 'WIP Tracking', capabilities: [cap('wip:update')] },
      { key: 'qc', label: 'QC Checkpoints', capabilities: [cap('qc:inspect'), cap('qc:approve')] },
    ],
  },
  {
    label: 'Outsourcing', items: [
      { key: 'karigar', label: 'Karigar Ledger / Issue-Return', capabilities: [cap('karigar:view'), cap('karigar:issue'), cap('karigar:return')] },
      { key: 'subcon', label: 'Sub-Contractor Invoices', capabilities: [cap('subcon:invoice')] },
    ],
  },
  {
    label: 'Quality & Compliance', items: [
      { key: 'hallmark', label: 'Hallmarking', capabilities: [cap('hallmark:manage')] },
      {
        key: 'repair', label: 'Repair Jobs',
        // repair:manage still gates two workflow actions (status transition, add transaction) that
        // aren't create/edit-shaped — kept alongside the genuine view/create/edit split, not replaced.
        capabilities: [cap('repair:view'), cap('repair:create'), cap('repair:edit'), cap('repair:manage')],
      },
    ],
  },
  {
    label: 'Jewelry Tagging', items: [
      { key: 'tag', label: 'Tags & Inventory / Stock Lookup', capabilities: [cap('tag:view'), cap('tag:create')] },
      {
        key: 'tagTemplate', label: 'Tag Label Designer',
        capabilities: [cap('tagTemplate:view'), cap('tagTemplate:create'), cap('tagTemplate:edit')],
      },
      // Sold-then-returned pieces: the branch sends them to Head Office (repair:send); only HO-authorised users receive,
      // inspect, repair and retag them. Viewing the Repair Register reuses repair:view.
      {
        key: 'returnRepair', label: 'Returned Jewellery (Repair Register)',
        capabilities: [cap('repair:send'), cap('repair:receive'), cap('repair:inspect'), cap('repair:work'), cap('retag:create'), cap('retag:reprint')],
      },
      { key: 'branch', label: 'Branches', capabilities: [cap('branch:create'), cap('branch:edit')] },
      // A distinct feature from Branches (the master record) — moving stock between branches, and
      // approving that move — so it stays its own row instead of being bundled under branch:manage.
      { key: 'branchTransfer', label: 'Branch Transfers', capabilities: [cap('branch:transfer'), cap('branch:approve')] },
    ],
  },
  {
    label: 'Estimation', items: [
      { key: 'estimation', label: 'Estimate a Piece', capabilities: [cap('estimation:view'), cap('estimation:manage')] },
      {
        key: 'estimateTemplate', label: 'Estimate Templates',
        capabilities: [cap('estimateTemplate:view'), cap('estimateTemplate:create'), cap('estimateTemplate:edit')],
      },
    ],
  },
  {
    label: 'Sales & Export', items: [
      {
        key: 'client', label: 'Clients / Customers',
        // J3 Decision 3: deactivate/reactivate and hard delete are deliberately their own
        // capabilities, separate from client:edit (CLAUDE.md §"J3 — Universal Edit/Delete/Restore").
        capabilities: [cap('client:view'), cap('client:create'), cap('client:edit'), cap('client:deactivate'), cap('client:delete')],
      },
      { key: 'sales', label: 'Sales Invoices / Memo-Out', capabilities: [cap('sales:view'), cap('sales:create'), cap('memo:manage')] },
      {
        key: 'invoice', label: 'Invoicing',
        // J3 Decision 5: invoice:void is a whole-invoice reversal, distinct from invoice:edit (amend).
        capabilities: [cap('invoice:create'), cap('invoice:edit'), cap('invoice:void')],
      },
      {
        key: 'payment', label: 'Payments & Receipts',
        // J3 Decision 1/2: payment:reverse is a compensating reversal, never an edit/delete of the
        // original row (see reverseInvoicePayment in sales.service.ts). J4-D6: payment:view is new —
        // GET /sales/clients/:clientId/payments used to ride sales:view.
        capabilities: [cap('payment:view'), cap('payment:create'), cap('payment:reverse')],
      },
      // Payment Configuration: bank/provider master, branch availability and POS terminals (TID/MID). Reading the
      // per-branch options on a collection screen needs only payment:create / payment:view.
      { key: 'paymentConfig', label: 'Payment Providers & POS Terminals', capabilities: [cap('paymentConfig:view'), cap('paymentConfig:manage')] },
      { key: 'return', label: 'Sales Returns', capabilities: [cap('return:create')] },
      { key: 'exportDoc', label: 'Export Documents', capabilities: [cap('export:doc')] },
    ],
  },
  {
    label: 'Finance', items: [
      { key: 'finance', label: 'Finance & Ledgers', capabilities: [cap('finance:view')] },
      { key: 'journal', label: 'Journal Entries', capabilities: [cap('journal:create'), cap('journal:post')] },
      { key: 'tax', label: 'Tax', capabilities: [cap('tax:manage')] },
    ],
  },
  {
    label: 'GST & Compliance', items: [
      // G1 Part K: a company's GST registration(s) — separate from ordinary masters (masters:*)
      // since a GSTIN is a statutory identity record, not a rate/category master.
      {
        key: 'gstRegistration', label: 'GST Registrations',
        capabilities: [cap('gst:registration_view'), cap('gst:registration_create'), cap('gst:registration_edit'), cap('gst:registration_manage')],
      },
      // G1 Part L: mirrors tagTemplate:view/create/edit and estimateTemplate:view/create/edit's
      // exact 3-verb convention — printing an invoice only needs to READ the resolved template,
      // so view is separate from the write actions, same reasoning as estimateTemplate's split.
      {
        key: 'taxInvoiceTemplate', label: 'Tax Invoice Templates',
        capabilities: [cap('taxInvoiceTemplate:view'), cap('taxInvoiceTemplate:create'), cap('taxInvoiceTemplate:edit')],
      },
      // G2a: schema/RLS foundation only (CLAUDE.md's G2a entry) — no creation/cancellation service
      // exists yet. Cataloged now (ungrantable-but-known, same posture as J4-D3's SUPER_ADMIN-only
      // admin permissions) so the Role Editor can grant them the moment G2b ships the capability,
      // with no further permission-catalog change needed. Not assigned to any starter role.
      {
        key: 'creditNote', label: 'GST Credit Notes',
        capabilities: [cap('creditNote:view'), cap('creditNote:create'), cap('creditNote:cancel')],
      },
      {
        key: 'debitNote', label: 'GST Debit Notes',
        capabilities: [cap('debitNote:view'), cap('debitNote:create'), cap('debitNote:cancel')],
      },
      // G2g-4b: sell-side (outward) Debit Note — a wholly separate permission family from
      // 'debitNote' above (procurement/purchase-side). Cataloged but, per the approved G2g-4b.2
      // execution plan, deliberately NOT assigned to any starter role in this pass — same
      // "ungrantable-but-known, Role Editor can grant the moment it's needed" posture the
      // creditNote/debitNote entries above already documented when THEY shipped ahead of any
      // starter-role grant.
      {
        key: 'salesDebitNote', label: 'GST Sales Debit Notes',
        capabilities: [cap('salesDebitNote:view'), cap('salesDebitNote:create'), cap('salesDebitNote:cancel')],
      },
      // G2g-6a: schema/RLS foundation only (CLAUDE.md's G2g-6a entry) — no snapshot builder or
      // filing service exists yet. Cataloged but deliberately NOT assigned to any starter role in
      // this pass, same "ungrantable-but-known, Role Editor can grant the moment it's needed"
      // posture as creditNote/debitNote/salesDebitNote above when THEY shipped ahead of any
      // starter-role grant. gst:period_lock_override is deliberately NOT added — the unlock/override
      // decision has not been approved for v1.
      {
        key: 'gstFiling', label: 'GST Return Filing (Periods & Snapshots)',
        capabilities: [cap('gst:period_view'), cap('gst:snapshot_create'), cap('gst:snapshot_export'), cap('gst:filing_record')],
      },
      // G8a: infrastructure for a FUTURE e-invoice/IRP/E-Way Bill provider — config + encrypted
      // credentials + a read-only connection test, never an IRN/EWB mutation (none exists yet).
      // Deliberately NOT assigned to any starter role (SUPER_ADMIN only, via the wildcard) per the
      // phase's own decision — same "cataloged but ungrantable until deployed" posture as gstFiling
      // above when IT shipped ahead of a starter-role grant.
      {
        key: 'gstIntegration', label: 'GST Integration (e-Invoice/IRP Foundation)',
        capabilities: [cap('gst:integration_view'), cap('gst:integration_manage'), cap('gst:integration_test'),
          // G8c: a statutory MUTATION (registers an IRN) — its own permission, never riding the view one. SUPER_ADMIN only until granted.
          cap('gst:einvoice_generate')],
      },
      {
        key: 'creditNoteTemplate', label: 'Credit Note Templates',
        capabilities: [cap('creditNoteTemplate:view'), cap('creditNoteTemplate:create'), cap('creditNoteTemplate:edit')],
      },
      {
        key: 'debitNoteTemplate', label: 'Debit Note Templates',
        capabilities: [cap('debitNoteTemplate:view'), cap('debitNoteTemplate:create'), cap('debitNoteTemplate:edit')],
      },
    ],
  },
  {
    label: 'Hardware', items: [
      { key: 'hardware', label: 'Hardware Devices', capabilities: [cap('hardware:manage')] },
    ],
  },
  {
    label: 'Photography', items: [
      {
        key: 'photography', label: 'Tag Photography',
        capabilities: [cap('photography:view'), cap('photography:capture'), cap('photography:review'),
          cap('photography:delete'), cap('photography:restore'),
          cap('photography:manage_stations'), cap('photography:manage_cameras'), cap('photography:manage_settings')],
      },
    ],
  },
  {
    label: 'Offers', items: [
      // Dated sale-rate offers (making charge / VA / stone / metal). Applying an offer to an estimate or bill
      // needs no extra permission — it is automatic; this only governs who may define and change offers.
      { key: 'offer', label: 'Offer Management', capabilities: [cap('offer:view'), cap('offer:create'), cap('offer:edit'), cap('offer:delete')] },
      // Selling below an offered rate (a hand-lowered rate or an extra discount on an offer bill) needs a second person's
      // approval. Anyone who can bill may REQUEST it; only a holder of discount:approve can decide one (never their own).
      { key: 'discount', label: 'Below-offer Approvals', capabilities: [cap('discount:approve')] },
    ],
  },
  {
    label: 'Masters', items: [
      {
        key: 'masters', label: 'Masters (karats, HSN, categories, ...)',
        capabilities: [cap('masters:view'), cap('masters:create'), cap('masters:edit'), cap('masters:delete')],
      },
    ],
  },
  {
    label: 'Users & Roles', items: [
      { key: 'user', label: 'Users & Invitations', capabilities: [cap('user:manage')] },
      {
        key: 'role', label: 'Roles & Permissions',
        capabilities: [cap('role:view'), cap('role:create'), cap('role:edit'), cap('role:delete')],
      },
    ],
  },
  {
    label: 'Settings', items: [
      { key: 'system', label: 'System Configuration', capabilities: [cap('system:config')] },
    ],
  },
];

// Every row gets the full View / Create / Edit / Delete / Export set so a company's Super Admin can
// delegate any of them to any role (CLAUDE.md §6.2). Anything added here that no requirePermission(...)
// call enforces yet is flagged `enforced: false` so the Role Editor can say so honestly: granting it is
// stored and valid, but it changes nothing until an endpoint checks it. (Every permission an endpoint
// already enforces was in the catalog before this padding ran, so a padded entry is never enforced.)
const STANDARD_ACTIONS: { permission: string; action: string; label: string; aliases: string[] }[] = [
  { permission: 'view', action: 'view', label: 'View', aliases: ['View'] },
  { permission: 'create', action: 'create', label: 'Create', aliases: ['Create'] },
  { permission: 'edit', action: 'edit', label: 'Edit', aliases: ['Edit', 'Update'] },
  { permission: 'delete', action: 'delete', label: 'Delete', aliases: ['Delete'] },
  { permission: 'export', action: 'export', label: 'Export', aliases: ['Export'] },
];

(function padStandardCapabilities() {
  const taken = new Set(PERMISSION_CATALOG.flatMap((g) => g.items.flatMap((i) => i.capabilities.map((c) => c.permission))));
  for (const group of PERMISSION_CATALOG) {
    for (const item of group.items) {
      const prefixes = new Set(item.capabilities.map((c) => c.permission.split(':')[0]));
      const hasUnderscoreAction = item.capabilities.some((c) => c.permission.split(':')[1]?.includes('_'));
      // A row with one plain resource prefix keeps it (stock:view -> stock:export); a mixed or
      // underscore-action row (gst:registration_*) gets its own key as the prefix so it can't collide.
      const prefix = prefixes.size === 1 && !hasUnderscoreAction ? [...prefixes][0] : item.key;
      for (const std of STANDARD_ACTIONS) {
        if (item.capabilities.some((c) => std.aliases.includes(c.action))) continue;
        let permission = `${prefix}:${std.permission}`;
        if (taken.has(permission)) permission = `${item.key}:${std.permission}`;
        if (taken.has(permission)) continue;
        taken.add(permission);
        item.capabilities.push({ action: std.label, permission, enforced: false });
      }
    }
  }
})();

export const ALL_CATALOG_PERMISSIONS: ReadonlySet<string> = new Set(
  PERMISSION_CATALOG.flatMap((g) => g.items.flatMap((i) => i.capabilities.map((c) => c.permission)))
);

/** Every permission string in `permissions` must be a known catalog entry, or the '*' wildcard. */
export function isValidPermissionList(permissions: unknown): permissions is string[] {
  return (
    Array.isArray(permissions) &&
    permissions.every((p) => typeof p === 'string' && (p === '*' || ALL_CATALOG_PERMISSIONS.has(p)))
  );
}
