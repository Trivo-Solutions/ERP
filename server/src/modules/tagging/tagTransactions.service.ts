import { AppError } from '../../middleware/error';
import { TenantContext, canAccessBranch, tenantQuery } from '../../shared/tenantContext';

// Jewel transaction history: every business document a single tag has ever appeared on — purchase / tagging,
// branch transfers, memos, sales, returns — as one chronological ledger. Unlike Barcode History (field-level
// before/after diffs captured by a trigger), this reads the real source documents, so each row names the book,
// the document number and the party. Read-only: nothing here is stored twice.
//
// Branch scope is the same rule as getTag: a tag outside the caller's branch grants is a 404, never a 403.

export interface TagTransactionRow {
  key: string;
  date: Date;
  type: string;          // stable code, for filtering/colouring on the client
  transaction: string;   // human label, e.g. "Jewelry Sales"
  branchName: string | null;
  bookName: string;
  docNo: string | null;
  party: string | null;
  entryBy: string | null;
  remarks: string | null;
  amount: number | null;
  grossWeight: number | null;
  netWeight: number | null;
  qty: number;
}

type Seq = TagTransactionRow & { seq: number };

export async function getTagTransactions(ctx: TenantContext, tagId: string) {
  const cid = ctx.companyId;
  const tag = await tenantQuery(cid, (tx) => tx.jewelryTag.findFirst({
    where: { id: tagId, companyId: cid },
    include: {
      branch: { select: { id: true, name: true } },
      category: { select: { name: true } },
      subCategory: { select: { name: true } },
      collection: { select: { name: true } },
      stockType: { select: { name: true } },
      manufacturer: { select: { name: true } },
      createdBy: { select: { id: true, name: true } },
      grnItem: { select: { grn: { select: { grnNumber: true, receivedDate: true, branchId: true, po: { select: { supplier: { select: { name: true } } } } } } } },
      materials: { select: { materialType: true, weight: true, pieces: true } },
    },
  }));
  if (!tag || !canAccessBranch(ctx, tag.branchId)) throw new AppError('Tag not found', 404);

  const [invoiceItems, saleReturnItems, purchaseReturnItems, memoItems, transferItems, history] = await Promise.all([
    tenantQuery(cid, (tx) => tx.invoiceItem.findMany({
      where: { companyId: cid, tagId },
      select: {
        totalPrice: true,
        invoice: { select: {
          id: true, invoiceNumber: true, invoiceDate: true, invoiceType: true, status: true, voidedAt: true, voidReason: true,
          branch: { select: { name: true } }, client: { select: { name: true } }, voidedBy: { select: { id: true } },
        } },
      },
    })),
    tenantQuery(cid, (tx) => tx.salesReturnItem.findMany({
      where: { companyId: cid, tagId },
      select: { amount: true, return: { select: {
        id: true, returnNumber: true, returnDate: true, reason: true, notes: true,
        client: { select: { name: true } }, invoice: { select: { branch: { select: { name: true } } } },
      } } },
    })),
    tenantQuery(cid, (tx) => tx.purchaseReturnItem.findMany({
      where: { companyId: cid, tagId },
      select: { amount: true, return: { select: {
        id: true, returnNumber: true, returnDate: true, reason: true, notes: true, supplier: { select: { name: true } },
      } } },
    })),
    tenantQuery(cid, (tx) => tx.memoItem.findMany({
      where: { companyId: cid, tagId },
      select: { status: true, estimatedValue: true, memo: { select: {
        id: true, memoNumber: true, sentDate: true, notes: true, status: true, updatedAt: true,
        branch: { select: { name: true } }, client: { select: { name: true } },
      } } },
    })),
    tenantQuery(cid, (tx) => tx.branchTransferItem.findMany({
      where: { companyId: cid, tagId },
      select: { receivedAt: true, transfer: { select: {
        id: true, transferNumber: true, status: true, createdAt: true, updatedAt: true, dispatchedAt: true, notes: true,
        requestedById: true, approvedById: true,
        fromBranch: { select: { name: true } }, toBranch: { select: { name: true } },
      } } },
    })),
    // The trigger-captured history gives a branch + actor + exact moment for things the documents themselves
    // don't date (a memo item being handed back, which only flips a status).
    tenantQuery(cid, (tx) => tx.tagHistory.findMany({
      where: { companyId: cid, tagId }, orderBy: { createdAt: 'asc' },
      select: { event: true, branchId: true, changes: true, actorUserId: true, createdAt: true },
    })),
  ]);

  // "Entry By": the audit trail records who created each document and who received a transfer.
  const docIds = [
    ...invoiceItems.map((i) => i.invoice.id), ...saleReturnItems.map((i) => i.return.id),
    ...purchaseReturnItems.map((i) => i.return.id), ...memoItems.map((i) => i.memo.id),
    ...transferItems.map((i) => i.transfer.id),
  ];
  const audits = docIds.length ? await tenantQuery(cid, (tx) => tx.auditLog.findMany({
    where: {
      companyId: cid, recordId: { in: docIds }, action: { in: ['CREATE', 'RECEIVE'] },
      tableName: { in: ['sales_invoices', 'sales_returns', 'purchase_returns', 'memo_outs', 'branch_transfers'] },
    },
    orderBy: { timestamp: 'asc' }, select: { tableName: true, recordId: true, action: true, userId: true },
  })) : [];
  const auditUser = new Map<string, string>(); // first writer wins: the original creator
  for (const a of audits) { const k = `${a.tableName}:${a.recordId}:${a.action}`; if (!auditUser.has(k)) auditUser.set(k, a.userId); }

  const userIds = new Set<string>([tag.createdBy.id, ...auditUser.values()]);
  for (const t of transferItems) { userIds.add(t.transfer.requestedById); if (t.transfer.approvedById) userIds.add(t.transfer.approvedById); }
  for (const i of invoiceItems) if (i.invoice.voidedBy) userIds.add(i.invoice.voidedBy.id);
  for (const h of history) if (h.actorUserId) userIds.add(h.actorUserId);
  const members = await tenantQuery(cid, (tx) => tx.companyUser.findMany({
    where: { companyId: cid, userId: { in: [...userIds] } }, select: { userId: true, user: { select: { name: true } } },
  }));
  const nameOf = new Map(members.map((m) => [m.userId, m.user.name]));
  const who = (id: string | null | undefined) => (id ? nameOf.get(id) ?? null : null);
  const audited = (table: string, id: string, action = 'CREATE') => who(auditUser.get(`${table}:${id}:${action}`));

  const branchIds = [...new Set([tag.grnItem?.grn.branchId, ...history.map((h) => h.branchId)].filter((b): b is string => !!b))];
  const branchRows = branchIds.length ? await tenantQuery(cid, (tx) => tx.branch.findMany({
    where: { companyId: cid, id: { in: branchIds } }, select: { id: true, name: true },
  })) : [];
  const branchName = new Map(branchRows.map((b) => [b.id, b.name]));

  const gross = Number(tag.grossWeight);
  const net = Number(tag.netWeight);
  const out: Seq[] = [];
  let seq = 0;
  const add = (r: Omit<TagTransactionRow, 'grossWeight' | 'netWeight' | 'qty' | 'amount' | 'remarks' | 'entryBy' | 'party' | 'docNo' | 'branchName'> & Partial<TagTransactionRow>) =>
    out.push({
      docNo: null, party: null, entryBy: null, remarks: null, amount: null, branchName: null,
      grossWeight: gross, netWeight: net, qty: 1, ...r, seq: seq++,
    });

  // ── Purchase / tagging ────────────────────────────────────────────────────────
  const created = history.find((h) => h.event === 'CREATED');
  const grn = tag.grnItem?.grn;
  add({
    key: `tag:${tag.id}`, date: tag.createdAt,
    type: grn ? 'PURCHASE' : 'TAGGED', transaction: grn ? 'Purchase Receipt (Tagged)' : 'Jewelry Tagged',
    bookName: grn ? 'Goods Receipt' : 'Tagging', docNo: grn?.grnNumber ?? tag.tagNumber,
    party: grn?.po.supplier.name ?? tag.manufacturer?.name ?? null,
    branchName: (grn?.branchId && branchName.get(grn.branchId)) || (created?.branchId && branchName.get(created.branchId)) || tag.branch.name,
    // No amount: on this row it would be the cost price, which a tag:view screen must not expose.
    entryBy: tag.createdBy.name, remarks: tag.notes,
  });

  // ── Branch transfers ──────────────────────────────────────────────────────────
  for (const { transfer: t, receivedAt } of transferItems) {
    const base = { bookName: 'Branch Transfer', docNo: t.transferNumber };
    if (t.dispatchedAt) {
      add({ ...base, key: `xfer-out:${t.id}`, date: t.dispatchedAt, type: 'TRANSFER_ISSUE', transaction: 'Branch Transfer Issue',
        branchName: t.fromBranch.name, party: t.toBranch.name, entryBy: who(t.approvedById) ?? who(t.requestedById), remarks: t.notes });
    } else if (t.status === 'CANCELLED') {
      add({ ...base, key: `xfer-req:${t.id}`, date: t.createdAt, type: 'TRANSFER_REQUEST', transaction: 'Branch Transfer Requested',
        branchName: t.fromBranch.name, party: t.toBranch.name, entryBy: who(t.requestedById), remarks: t.notes });
      add({ ...base, key: `xfer-cancel:${t.id}`, date: t.updatedAt, type: 'TRANSFER_CANCEL', transaction: 'Branch Transfer Cancelled',
        branchName: t.fromBranch.name, party: t.toBranch.name, entryBy: who(t.requestedById), remarks: t.notes });
    } else {
      add({ ...base, key: `xfer-req:${t.id}`, date: t.createdAt, type: 'TRANSFER_REQUEST', transaction: 'Branch Transfer Pending',
        branchName: t.fromBranch.name, party: t.toBranch.name, entryBy: who(t.requestedById), remarks: t.notes });
    }
    if (receivedAt) {
      add({ ...base, key: `xfer-in:${t.id}`, date: receivedAt, type: 'TRANSFER_RECEIVE', transaction: 'Branch Transfer Receive',
        branchName: t.toBranch.name, party: t.fromBranch.name, entryBy: audited('branch_transfers', t.id, 'RECEIVE'), remarks: t.notes });
    }
  }

  // ── Memos (consignment) ───────────────────────────────────────────────────────
  for (const m of memoItems) {
    const memo = m.memo;
    const base = { bookName: 'Memo', docNo: memo.memoNumber, party: memo.client.name, branchName: memo.branch.name, amount: Number(m.estimatedValue) };
    add({ ...base, key: `memo-out:${memo.id}`, date: memo.sentDate, type: 'MEMO_OUT', transaction: 'Jewelry Memo Outward',
      entryBy: audited('memo_outs', memo.id), remarks: memo.notes });
    if (m.status === 'RETURNED') {
      // The status flip is the only record of the hand-back; take the first IN_STOCK flip after the memo went out.
      const flip = history.find((h) => h.createdAt >= memo.sentDate
        && (h.changes as Record<string, { from?: unknown; to?: unknown }> | null)?.status?.from === 'ON_APPROVAL'
        && (h.changes as Record<string, { to?: unknown }>).status.to === 'IN_STOCK');
      // No flip on record (history tracking began after the return) → the memo's last update is the best available
      // date, and the row says so rather than presenting a guess as fact.
      add({ ...base, key: `memo-ret:${memo.id}`, date: flip?.createdAt ?? memo.updatedAt, type: 'MEMO_RETURN', transaction: 'Jewelry Memo Return',
        branchName: (flip?.branchId && branchName.get(flip.branchId)) || memo.branch.name, entryBy: who(flip?.actorUserId),
        remarks: flip ? memo.notes : [memo.notes, 'Return date approximate'].filter(Boolean).join(' · ') });
    }
  }

  // ── Sales (direct and memo-converted both put the tag on an invoice line) ───────
  for (const { invoice: inv, totalPrice } of invoiceItems) {
    const base = { bookName: 'Sales Invoice', docNo: inv.invoiceNumber, party: inv.client.name, branchName: inv.branch.name };
    add({ ...base, key: `sale:${inv.id}`, date: inv.invoiceDate, type: 'SALE', transaction: 'Jewelry Sales',
      entryBy: audited('sales_invoices', inv.id), amount: Number(totalPrice) });
    if (inv.status === 'VOID' && inv.voidedAt) {
      add({ ...base, key: `void:${inv.id}`, date: inv.voidedAt, type: 'SALE_VOID', transaction: 'Jewelry Sales Void',
        entryBy: who(inv.voidedBy?.id), amount: Number(totalPrice), remarks: inv.voidReason });
    }
  }
  for (const { return: r, amount } of saleReturnItems) {
    add({ key: `sret:${r.id}`, date: r.returnDate, type: 'SALE_RETURN', transaction: 'Jewelry Sales Return', bookName: 'Sales Return', docNo: r.returnNumber,
      party: r.client.name, branchName: r.invoice.branch.name, entryBy: audited('sales_returns', r.id), amount: Number(amount), remarks: r.reason ?? r.notes });
  }
  for (const { return: r } of purchaseReturnItems) {
    add({ key: `pret:${r.id}`, date: r.returnDate, type: 'PURCHASE_RETURN', transaction: 'Jewelry Purchase Return', bookName: 'Purchase Return', docNo: r.returnNumber,
      party: r.supplier.name, branchName: tag.branch.name, entryBy: audited('purchase_returns', r.id), remarks: r.reason ?? r.notes });
  }

  // Newest first; the sequence keeps same-moment rows (issue/receive of one transfer) in the order they were added reversed,
  // i.e. later lifecycle steps on top.
  out.sort((a, b) => b.date.getTime() - a.date.getTime() || b.seq - a.seq);
  const rows: TagTransactionRow[] = out.map(({ seq: _s, ...r }) => r);

  let diaWt = 0; let csWt = 0;
  for (const m of tag.materials) {
    if (m.materialType === 'METAL') continue;
    if (m.materialType === 'DIAMOND') diaWt += Number(m.weight); else csWt += Number(m.weight);
  }

  return {
    tag: {
      id: tag.id, tagNumber: tag.tagNumber, name: tag.name, status: tag.status,
      branchName: tag.branch.name, category: tag.category?.name ?? null, subCategory: tag.subCategory?.name ?? null,
      collection: tag.collection?.name ?? null, stockType: tag.stockType?.name ?? null, manufacturer: tag.manufacturer?.name ?? null,
      metalType: tag.metalType, metalKarat: tag.metalKarat, huid: tag.huid,
      grossWeight: gross, netWeight: net, stoneWeight: Number(tag.stoneWeight),
      diaWt: Math.round(diaWt * 1000) / 1000, csWt: Math.round(csWt * 1000) / 1000,
      sellingPrice: Number(tag.sellingPrice),
      // costPrice is deliberately omitted — same posture as the Stock Lookup screen.
    },
    rows,
  };
}
