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

export interface PermissionCapability { action: string; permission: string }
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
  integration_view: 'View', integration_manage: 'Manage (Configure/Credentials)', integration_test: 'Test Connection',
};

function cap(permission: string): PermissionCapability {
  const action = permission.split(':')[1] ?? permission;
  return { action: ACTION_LABELS[action] ?? action, permission };
}

export const PERMISSION_CATALOG: PermissionCatalogGroup[] = [
  {
    label: 'General', items: [
      { key: 'dashboard', label: 'Dashboard & Reports', capabilities: [cap('report:view')] },
      // J4-D1: split out of report:view — client ledger, dealer/aging-receivables, day book, GST
      // summary (sales + purchase), supplier ledger, trial balance, P&L, balance sheet. Operational
      // reports (stock, WIP, karigar balances, sales register, dead stock, ...) stay on report:view.
      { key: 'financialReports', label: 'Sensitive Financial Reports', capabilities: [cap('report:financial_view')] },
      { key: 'audit', label: 'Audit Log', capabilities: [cap('audit:view')] },
    ],
  },
  {
    label: 'Product Design', items: [
      { key: 'design', label: 'Design Library / Metal Rates', capabilities: [cap('design:view'), cap('design:create'), cap('design:edit')] },
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
        capabilities: [cap('gst:integration_view'), cap('gst:integration_manage'), cap('gst:integration_test')],
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
