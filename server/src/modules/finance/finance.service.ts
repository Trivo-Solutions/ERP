import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { nextDocumentNumber } from '../../shared/numberSequence';
import { tenantQuery, tenantBatch, tenantTransaction, TenantContext, BranchAccess } from '../../shared/tenantContext';
import { assertOwnedByCompany, assertAllOwned } from '../../middleware/tenant';
import { CREDIT_SETTLEMENT_MODES, PAYMENT_MODE_CUSTOMER_ADVANCE } from '../../shared/constants';
import { getStarterPackage, type StarterAccount } from '../platform/starterPackage';
import { splitGst } from '../../shared/gstSplit';
import { round2 } from '../../shared/inputGst';

// ═══════════════════════════════════════════════════
// Phase 2 of the multi-tenant migration: every report/query in this file is now company-scoped.
// Account/JournalEntry/JournalLine/CostCenter all gained a direct companyId column (see the
// phase-2 migration) specifically so trial balance / P&L / balance sheet / cost-center
// profitability could be correctly scoped — a chart of accounts is fundamentally company-owned
// data, and a global one (the pre-Phase-2 shape) could never have supported a second company
// without every company sharing one balance sheet.
// ═══════════════════════════════════════════════════

// `tx` lets a caller that's already inside its own tenant-scoped transaction (a sale, a payment,
// a return, a GRN intake — see tenantTransaction in shared/tenantContext.ts) fold the journal
// entry into that same atomic unit. Called with no `tx` (financeRouter's manual /journals
// endpoint), it opens its own short tenant-scoped transaction (Form 3) — companyId is REQUIRED
// either way, never inferred.
export async function createJournalEntry(
  companyId: string,
  data: {
    date: Date; description: string; referenceType?: string; referenceId?: string;
    costCenterId?: string;
    lines: Array<{ accountId: string; debit: number; credit: number; narration?: string; }>;
  },
  userId: string,
  tx?: Prisma.TransactionClient
) {
  const totalDebit = data.lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = data.lines.reduce((s, l) => s + l.credit, 0);

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new AppError(`Journal entry not balanced: Dr ${totalDebit} ≠ Cr ${totalCredit}`, 400);
  }

  const run = async (c: Prisma.TransactionClient) => {
    if (data.costCenterId) await assertOwnedByCompany('costCenter', data.costCenterId, companyId, 'Cost center');
    // Layer 2: a JournalLine.accountId is a plain (non-composite) FK — Postgres FK checks bypass
    // RLS, so a forged Company-B account id would otherwise be accepted here and have its
    // balance mutated by postJournalEntry. Every line's account must be verified explicitly.
    await assertAllOwned('account', data.lines.map((l) => l.accountId), companyId, 'Account');
    const entryNumber = await nextDocumentNumber(companyId, 'JE', 'JE', c, data.date.getFullYear());
    return c.journalEntry.create({
      data: {
        companyId, entryNumber, date: data.date, description: data.description,
        referenceType: data.referenceType, referenceId: data.referenceId,
        costCenterId: data.costCenterId,
        totalDebit, totalCredit,
        lines: { createMany: { data: data.lines.map((l) => ({ ...l, companyId })) } },
      },
      include: {
        lines: { include: { account: { select: { code: true, name: true } } } },
        costCenter: { select: { name: true } },
      },
    });
  };

  if (tx) return run(tx);
  return tenantTransaction(companyId, run);
}

export async function postJournalEntry(companyId: string, entryId: string, tx?: Prisma.TransactionClient) {
  const run = async (c: Prisma.TransactionClient) => {
    const entry = await c.journalEntry.findUnique({ where: { id: entryId }, include: { lines: true } });
    if (!entry || entry.companyId !== companyId) throw new AppError('Journal entry not found', 404);
    if (entry.isPosted) throw new AppError('Entry already posted', 400);

    await c.journalEntry.update({ where: { id: entryId }, data: { isPosted: true, postedAt: new Date() } });

    for (const line of entry.lines) {
      const netChange = Number(line.debit) - Number(line.credit);
      await c.account.update({
        where: { id: line.accountId },
        data: { balance: { increment: netChange } },
      });
    }
  };

  if (tx) return run(tx);
  return tenantTransaction(companyId, run);
}

// F1: the entry point sales/procurement actually call. Unlike financeRouter's manual /journals
// (create as a draft, post separately), these are the automatic ledger side-effect of a business
// event that already happened — created and posted in one shot, inside the CALLER's own
// tenant-scoped transaction (always provided — this function has no standalone-call shape),
// keyed by account *code* (LEDGER_ACCOUNT in shared/ledgerAccounts.ts) resolved WITHIN this one
// company's own chart of accounts, never globally. Zero-value lines are dropped rather than
// posted as noise; if that leaves nothing to post, returns null.
export async function postAutoJournalEntry(
  tx: Prisma.TransactionClient,
  companyId: string,
  data: {
    date: Date; description: string; referenceType: string; referenceId: string; userId: string;
    lines: Array<{ accountCode: string; debit?: number; credit?: number; narration?: string }>;
  },
) {
  const lines = data.lines.filter((l) => Math.abs(l.debit ?? 0) > 0.001 || Math.abs(l.credit ?? 0) > 0.001);
  if (lines.length === 0) return null;

  const codes = Array.from(new Set(lines.map((l) => l.accountCode)));
  const accounts = await tx.account.findMany({ where: { code: { in: codes }, companyId } });
  const accountIdByCode = new Map(accounts.map((a) => [a.code, a.id]));
  const missing = codes.filter((c) => !accountIdByCode.has(c));
  if (missing.length > 0) {
    throw new AppError(`Ledger account(s) missing from this company's chart of accounts: ${missing.join(', ')} — run the finance seed`, 500);
  }

  const entry = await createJournalEntry(companyId, {
    date: data.date, description: data.description,
    referenceType: data.referenceType, referenceId: data.referenceId,
    lines: lines.map((l) => ({
      accountId: accountIdByCode.get(l.accountCode)!,
      debit: l.debit ?? 0, credit: l.credit ?? 0, narration: l.narration,
    })),
  }, data.userId, tx);

  await postJournalEntry(companyId, entry.id, tx);
  return entry;
}

export async function getTrialBalance(companyId: string, asOfDate?: Date) {
  const accounts = await tenantQuery(companyId, (tx) =>
    tx.account.findMany({
      where: { companyId, isActive: true },
      include: {
        journalLines: {
          where: { companyId, entry: { isPosted: true, ...(asOfDate && { date: { lte: asOfDate } }) } },
        },
      },
      orderBy: [{ type: 'asc' }, { code: 'asc' }],
    })
  );

  return accounts.map((acc) => {
    const totalDebit = acc.journalLines.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = acc.journalLines.reduce((s, l) => s + Number(l.credit), 0);
    const netBalance = totalDebit - totalCredit;

    return {
      id: acc.id, code: acc.code, name: acc.name,
      type: acc.type, subType: acc.subType,
      debit: netBalance > 0 ? netBalance : 0,
      credit: netBalance < 0 ? Math.abs(netBalance) : 0,
      balance: netBalance,
    };
  });
}

export async function getProfitAndLoss(companyId: string, from: Date, to: Date) {
  const entries = await tenantQuery(companyId, (tx) =>
    tx.journalLine.findMany({
      where: { companyId, entry: { isPosted: true, date: { gte: from, lte: to } } },
      include: { account: true },
    })
  );

  const revenue: Record<string, number> = {};
  const expenses: Record<string, number> = {};

  for (const line of entries) {
    const acc = line.account;
    if (acc.type === 'REVENUE') {
      revenue[acc.name] = (revenue[acc.name] ?? 0) + Number(line.credit) - Number(line.debit);
    } else if (acc.type === 'EXPENSE') {
      expenses[acc.name] = (expenses[acc.name] ?? 0) + Number(line.debit) - Number(line.credit);
    }
  }

  const totalRevenue = Object.values(revenue).reduce((s, v) => s + v, 0);
  const totalExpenses = Object.values(expenses).reduce((s, v) => s + v, 0);
  const netProfit = totalRevenue - totalExpenses;

  return { revenue, expenses, totalRevenue, totalExpenses, netProfit, period: { from, to } };
}

export async function getBalanceSheet(companyId: string, asOfDate: Date) {
  const tb = await getTrialBalance(companyId, asOfDate);

  const assets = tb.filter((a) => a.type === 'ASSET');
  const liabilities = tb.filter((a) => a.type === 'LIABILITY');
  const equity = tb.filter((a) => a.type === 'EQUITY');

  return {
    assets: { items: assets, total: assets.reduce((s, a) => s + a.balance, 0) },
    liabilities: { items: liabilities, total: liabilities.reduce((s, a) => s + Math.abs(a.balance), 0) },
    equity: { items: equity, total: equity.reduce((s, a) => s + Math.abs(a.balance), 0) },
    asOfDate,
  };
}

export async function getCostCenterProfitability(companyId: string) {
  const centers = await tenantQuery(companyId, (tx) =>
    tx.costCenter.findMany({
      where: { companyId, isActive: true },
      include: {
        journalEntries: {
          where: { companyId, isPosted: true },
          include: { lines: { include: { account: true } } },
        },
      },
    })
  );

  return centers.map((cc) => {
    let revenue = 0, expenses = 0;
    for (const je of cc.journalEntries) {
      for (const line of je.lines) {
        if (line.account.type === 'REVENUE') revenue += Number(line.credit) - Number(line.debit);
        if (line.account.type === 'EXPENSE') expenses += Number(line.debit) - Number(line.credit);
      }
    }
    return { id: cc.id, name: cc.name, department: cc.department, revenue, expenses, profit: revenue - expenses };
  });
}

// F3: aging of every client's unpaid balance, bucketed by how overdue each invoice is.
export async function getDealerAging(companyId: string, asOfDate?: Date) {
  const cutoff = asOfDate ?? new Date();
  const invoices = await tenantQuery(companyId, (tx) =>
    tx.salesInvoice.findMany({
      // J3.5 Finding 1: a VOID invoice keeps balanceDue == totalAmount by design (voiding never
      // touches it — void's own eligibility already required zero payments) but is not a live
      // receivable; it must not age here.
      where: { companyId, balanceDue: { gt: 0 }, status: { not: 'VOID' } },
      select: {
        dueDate: true, invoiceDate: true, balanceDue: true,
        client: {
          select: {
            id: true, clientCode: true, name: true, type: true,
            creditLimit: true, currentBalance: true,
          },
        },
      },
    })
  );

  type Row = {
    clientId: string; clientCode: string; name: string; type: string;
    creditLimit: number | null; currentBalance: number; overLimit: boolean;
    bucket0to30: number; bucket31to60: number; bucket61to90: number; bucket90plus: number; total: number;
  };
  const byClient = new Map<string, Row>();

  for (const inv of invoices) {
    const anchor = inv.dueDate ?? inv.invoiceDate;
    const ageDays = Math.floor((cutoff.getTime() - new Date(anchor).getTime()) / 86_400_000);
    const amount = Number(inv.balanceDue);

    let row = byClient.get(inv.client.id);
    if (!row) {
      const creditLimit = inv.client.creditLimit != null ? Number(inv.client.creditLimit) : null;
      const currentBalance = Number(inv.client.currentBalance);
      row = {
        clientId: inv.client.id, clientCode: inv.client.clientCode, name: inv.client.name,
        type: inv.client.type, creditLimit, currentBalance,
        overLimit: creditLimit != null && currentBalance > creditLimit,
        bucket0to30: 0, bucket31to60: 0, bucket61to90: 0, bucket90plus: 0, total: 0,
      };
      byClient.set(inv.client.id, row);
    }

    if (ageDays <= 30) row.bucket0to30 += amount;
    else if (ageDays <= 60) row.bucket31to60 += amount;
    else if (ageDays <= 90) row.bucket61to90 += amount;
    else row.bucket90plus += amount;
    row.total += amount;
  }

  const rows = Array.from(byClient.values()).sort((a, b) => b.total - a.total);
  const sum = (key: keyof Row) => rows.reduce((s, r) => s + (r[key] as number), 0);

  return {
    asOfDate: cutoff,
    rows,
    totals: {
      bucket0to30: sum('bucket0to30'), bucket31to60: sum('bucket31to60'),
      bucket61to90: sum('bucket61to90'), bucket90plus: sum('bucket90plus'),
      total: sum('total'),
    },
  };
}

// F4: one client's full account statement. Layer 2: clientId is validated as belonging to
// companyId FIRST — a Company-B clientId must 404, not silently return someone else's
// statement. Every subsequent query is additionally scoped by companyId directly (not just the
// already-validated clientId) for defense in depth and RLS-session-variable consistency.
export async function getClientLedger(ctx: TenantContext, clientId: string, from?: Date, to?: Date) {
  await assertOwnedByCompany('client', clientId, ctx.companyId, 'Client');

  const client = await tenantQuery(ctx.companyId, (tx) =>
    tx.client.findUniqueOrThrow({
      where: { id: clientId },
      select: { id: true, clientCode: true, name: true, type: true, creditLimit: true, currentBalance: true },
    })
  );

  const [invoices, payments, returns, exchanges, creditNotes, salesDebitNotes] = await tenantBatch(ctx.companyId, (tx) => [
    tx.salesInvoice.findMany({
      // J3.5 Finding 1: a VOID invoice's debit is reversed the moment it's voided (client.currentBalance
      // is decremented in the same transaction) — including it here with no offsetting entry would make
      // this statement's own computed closingBalance disagree with client.currentBalance below.
      where: { companyId: ctx.companyId, clientId, status: { not: 'VOID' } },
      select: { id: true, invoiceNumber: true, invoiceDate: true, totalAmount: true, createdAt: true },
    }),
    tx.invoicePayment.findMany({
      // Not OLD_GOLD / STORE_CREDIT: those settle a bill out of credit already shown above as the exchange / return
      // row, so listing them as receipts too would credit the customer twice. Not reversed (J3 Decision 1): a
      // reversed payment's original row is kept for the audit trail but never counts as a receipt again.
      where: { companyId: ctx.companyId, clientId, mode: { notIn: CREDIT_SETTLEMENT_MODES }, reversedAt: null },
      select: {
        id: true, paymentNumber: true, paymentDate: true, amount: true, mode: true, createdAt: true,
        invoice: { select: { invoiceNumber: true } },
      },
    }),
    tx.salesReturn.findMany({
      where: { companyId: ctx.companyId, clientId },
      select: {
        id: true, returnNumber: true, returnDate: true, totalAmount: true, createdAt: true,
        invoice: { select: { invoiceNumber: true } },
      },
    }),
    tx.oldGoldExchange.findMany({
      where: { companyId: ctx.companyId, clientId },
      select: { id: true, exchangeNumber: true, exchangeDate: true, valuedAmount: true, createdAt: true },
    }),
    // G2c follow-up: a standalone (Path B) Credit Note moves currentBalance exactly like a
    // SalesReturn/OldGoldExchange and must appear here for the same reason. A Path A (return-linked)
    // one — salesReturnId set — is excluded: its balance movement is the SalesReturn row above; the
    // CreditNote itself posted no separate currentBalance change (creditNote.service.ts), so listing
    // it too would double-count. CANCELLED is excluded the same way a reversed payment is above — its
    // balance effect was undone at cancellation, so the active statement should not show it at all.
    tx.creditNote.findMany({
      where: { companyId: ctx.companyId, clientId, salesReturnId: null, status: { not: 'CANCELLED' } },
      select: {
        id: true, creditNoteNumber: true, creditNoteDate: true, totalAmount: true, createdAt: true,
        originalInvoiceNumber: true,
      },
    }),
    // G2g-4b: a Sales Debit Note moves currentBalance exactly like a SalesInvoice — a debit,
    // increasing what the customer owes — and must appear here for the same reason. CANCELLED is
    // excluded the same way a CANCELLED CreditNote is above — its balance effect was undone at
    // cancellation.
    tx.salesDebitNote.findMany({
      where: { companyId: ctx.companyId, clientId, status: { not: 'CANCELLED' } },
      select: {
        id: true, debitNoteNumber: true, debitNoteDate: true, totalAmount: true, createdAt: true,
        originalInvoiceNumber: true,
      },
    }),
  ]);

  type Entry = {
    date: Date; createdAt: Date; type: string; refNumber: string; description: string;
    debit: number; credit: number;
  };
  const entries: Entry[] = [
    ...invoices.map((inv): Entry => ({
      date: inv.invoiceDate, createdAt: inv.createdAt, type: 'INVOICE', refNumber: inv.invoiceNumber,
      description: `Sale invoice ${inv.invoiceNumber}`, debit: Number(inv.totalAmount), credit: 0,
    })),
    ...payments.map((p): Entry => ({
      date: p.paymentDate, createdAt: p.createdAt, type: 'PAYMENT', refNumber: p.paymentNumber,
      description: p.invoice ? `Payment ${p.paymentNumber} (${p.mode}) against ${p.invoice.invoiceNumber}`
        : `Payment ${p.paymentNumber} (${p.mode}, on-account)`,
      debit: 0, credit: Number(p.amount),
    })),
    ...returns.map((r): Entry => ({
      date: r.returnDate, createdAt: r.createdAt, type: 'RETURN', refNumber: r.returnNumber,
      description: `Sales return ${r.returnNumber} against ${r.invoice.invoiceNumber}`,
      debit: 0, credit: Number(r.totalAmount),
    })),
    ...exchanges.map((e): Entry => ({
      date: e.exchangeDate, createdAt: e.createdAt, type: 'EXCHANGE', refNumber: e.exchangeNumber,
      description: `Old gold exchange ${e.exchangeNumber}`, debit: 0, credit: Number(e.valuedAmount),
    })),
    ...creditNotes.map((cn): Entry => ({
      date: cn.creditNoteDate, createdAt: cn.createdAt, type: 'CREDIT_NOTE', refNumber: cn.creditNoteNumber,
      description: `Credit note ${cn.creditNoteNumber} against ${cn.originalInvoiceNumber}`,
      debit: 0, credit: Number(cn.totalAmount),
    })),
    ...salesDebitNotes.map((dn): Entry => ({
      date: dn.debitNoteDate, createdAt: dn.createdAt, type: 'SALES_DEBIT_NOTE', refNumber: dn.debitNoteNumber,
      description: `Sales debit note ${dn.debitNoteNumber} against ${dn.originalInvoiceNumber}`,
      debit: Number(dn.totalAmount), credit: 0,
    })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime() || a.createdAt.getTime() - b.createdAt.getTime());

  let running = 0;
  const allRows = entries.map((e) => {
    running += e.debit - e.credit;
    return { ...e, balance: running };
  });

  const openingBalance = from
    ? (allRows.filter((r) => r.date < from).at(-1)?.balance ?? 0)
    : 0;
  const rows = allRows.filter((r) => (!from || r.date >= from) && (!to || r.date <= to));
  const closingBalance = rows.at(-1)?.balance ?? openingBalance;

  return {
    client: {
      id: client.id, clientCode: client.clientCode, name: client.name, type: client.type,
      creditLimit: client.creditLimit != null ? Number(client.creditLimit) : null,
      currentBalance: Number(client.currentBalance),
    },
    from: from ?? null, to: to ?? null,
    openingBalance, closingBalance, rows,
  };
}

// One supplier's account statement — the buy-side mirror of getClientLedger. Merges exactly the
// three things that move Supplier.currentDue: finished-goods intake (goods + input GST, credit — we
// owe more), purchase returns and supplier payments (debit — we owe less). Running balance is what
// we owe the supplier (positive = payable; negative = an advance paid to them). Computed from full
// history first so a `from`-cutoff opening balance is right even when the display range is narrower.
export async function getSupplierLedger(ctx: TenantContext, supplierId: string, from?: Date, to?: Date) {
  await assertOwnedByCompany('supplier', supplierId, ctx.companyId, 'Supplier');

  const supplier = await tenantQuery(ctx.companyId, (tx) =>
    tx.supplier.findUniqueOrThrow({
      where: { id: supplierId },
      select: { id: true, supplierCode: true, name: true, gstNumber: true, currentDue: true },
    })
  );

  const [bought, returns, payments, debitNotes] = await tenantBatch(ctx.companyId, (tx) => [
    tx.grnItem.findMany({
      where: { companyId: ctx.companyId, OR: [{ jewelryTag: { isNot: null } }, { purchaseLot: { isNot: null } }], poItem: { po: { supplierId } } },
      select: {
        taxableValue: true, inputCgst: true, inputSgst: true, inputIgst: true,
        grn: { select: { grnNumber: true, receivedDate: true, invoiceNumber: true, createdAt: true } },
        jewelryTag: { select: { tagNumber: true, costPrice: true } },
        purchaseLot: { select: { label: true, totalCost: true } },
      },
    }),
    tx.purchaseReturn.findMany({
      where: { companyId: ctx.companyId, supplierId },
      select: { returnNumber: true, returnDate: true, totalAmount: true, taxAmount: true, createdAt: true },
    }),
    tx.supplierPayment.findMany({
      // A reversed payment is kept for the audit trail but no longer counts as money paid.
      where: { companyId: ctx.companyId, supplierId, reversedAt: null },
      select: { paymentNumber: true, paymentDate: true, amount: true, mode: true, createdAt: true },
    }),
    // G2e: a standalone (Path B) Debit Note moves Supplier.currentDue exactly like a
    // PurchaseReturn/SupplierPayment and must appear here for the same reason. A Path A
    // (return-linked) one — purchaseReturnId set — is excluded: its balance movement is the
    // PurchaseReturn row above; the DebitNote itself posted no separate currentDue change
    // (debitNote.service.ts), so listing it too would double-count. CANCELLED is excluded the same
    // way a reversed InvoicePayment is on the sell side — its balance effect was undone at
    // cancellation, so the active statement should not show it at all.
    tx.debitNote.findMany({
      where: { companyId: ctx.companyId, supplierId, purchaseReturnId: null, status: { not: 'CANCELLED' } },
      select: { debitNoteNumber: true, debitNoteDate: true, totalAmount: true, createdAt: true },
    }),
  ]);

  type Entry = { date: Date; createdAt: Date; type: string; refNumber: string; description: string; debit: number; credit: number };
  const entries: Entry[] = [
    ...bought.map((g): Entry => ({
      date: g.grn.receivedDate, createdAt: g.grn.createdAt, type: 'PURCHASE', refNumber: g.grn.grnNumber,
      description: `Received ${g.jewelryTag ? g.jewelryTag.tagNumber : `lot ${g.purchaseLot!.label}`}${g.grn.invoiceNumber ? ` (bill ${g.grn.invoiceNumber})` : ''}`,
      debit: 0,
      // Intake before input GST existed has no stamped taxableValue: the tag's cost, no tax.
      credit: g.taxableValue != null
        ? Number(g.taxableValue) + Number(g.inputCgst) + Number(g.inputSgst) + Number(g.inputIgst)
        : Number(g.jewelryTag ? g.jewelryTag.costPrice : g.purchaseLot!.totalCost),
    })),
    ...returns.map((r): Entry => ({
      date: r.returnDate, createdAt: r.createdAt, type: 'RETURN', refNumber: r.returnNumber,
      description: `Purchase return ${r.returnNumber}`, debit: Number(r.totalAmount) + Number(r.taxAmount), credit: 0,
    })),
    ...payments.map((p): Entry => ({
      date: p.paymentDate, createdAt: p.createdAt, type: 'PAYMENT', refNumber: p.paymentNumber,
      description: `Payment ${p.paymentNumber} (${p.mode})`, debit: Number(p.amount), credit: 0,
    })),
    ...debitNotes.map((d): Entry => ({
      date: d.debitNoteDate, createdAt: d.createdAt, type: 'DEBIT_NOTE', refNumber: d.debitNoteNumber,
      description: `Debit note ${d.debitNoteNumber}`, debit: Number(d.totalAmount), credit: 0,
    })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime() || a.createdAt.getTime() - b.createdAt.getTime());

  let running = 0;
  const allRows = entries.map((e) => {
    running += e.credit - e.debit;
    return { ...e, balance: running };
  });

  const openingBalance = from ? (allRows.filter((r) => r.date < from).at(-1)?.balance ?? 0) : 0;
  const rows = allRows.filter((r) => (!from || r.date >= from) && (!to || r.date <= to));
  const closingBalance = rows.at(-1)?.balance ?? openingBalance;

  return {
    supplier: {
      id: supplier.id, supplierCode: supplier.supplierCode, name: supplier.name, gstNumber: supplier.gstNumber,
      currentDue: Number(supplier.currentDue),
    },
    from: from ?? null, to: to ?? null,
    openingBalance, closingBalance, rows,
  };
}

// H4: one day's company-wide rollup.
export async function getDayBook(companyId: string, date: Date) {
  const start = new Date(date); start.setHours(0, 0, 0, 0);
  const end = new Date(date); end.setHours(23, 59, 59, 999);

  const [invoices, payments, returns, exchanges, creditNotes, debitNotes, salesDebitNotes] = await tenantBatch(companyId, (tx) => [
    tx.salesInvoice.findMany({
      // J3.5 Finding 1: a voided invoice keeps its original invoiceDate — without this exclusion it
      // would inflate that day's sales total forever, however long after that day it was voided.
      where: { companyId, invoiceDate: { gte: start, lte: end }, status: { not: 'VOID' } },
      select: { invoiceNumber: true, invoiceType: true, totalAmount: true, client: { select: { name: true } } },
    }),
    tx.invoicePayment.findMany({
      // Money received only — an applied customer advance is cash booked on the day it was received (not here); old gold / store credit settlements are already in the exchanges / returns below.
      // Not reversed (J3 Decision 1) — a reversed payment moved no money for this day's rollup either.
      where: { companyId, paymentDate: { gte: start, lte: end }, mode: { notIn: [...CREDIT_SETTLEMENT_MODES, PAYMENT_MODE_CUSTOMER_ADVANCE] }, reversedAt: null },
      select: { mode: true, amount: true },
    }),
    tx.salesReturn.findMany({
      where: { companyId, returnDate: { gte: start, lte: end } },
      select: { returnNumber: true, totalAmount: true },
    }),
    tx.oldGoldExchange.findMany({
      where: { companyId, exchangeDate: { gte: start, lte: end } },
      select: { exchangeNumber: true, valuedAmount: true },
    }),
    // G2c follow-up: same reporting gap as getClientLedger — a standalone Credit Note moves money
    // (a customer-balance credit) on the day it's issued and belongs in this rollup; a return-linked
    // one is excluded so it isn't counted twice alongside its own SalesReturn row above.
    tx.creditNote.findMany({
      where: { companyId, creditNoteDate: { gte: start, lte: end }, salesReturnId: null, status: { not: 'CANCELLED' } },
      select: { creditNoteNumber: true, totalAmount: true },
    }),
    // G2e: same reporting shape as creditNotes above, purchase side — only active standalone
    // (Path B) Debit Notes; a Path A one is excluded since it carries no accounting movement of
    // its own (the PurchaseReturn it wraps has none in this rollup either — this function never
    // reads PurchaseReturn's money movement, only SalesReturn's, on the sell side).
    tx.debitNote.findMany({
      where: { companyId, debitNoteDate: { gte: start, lte: end }, purchaseReturnId: null, status: { not: 'CANCELLED' } },
      select: { debitNoteNumber: true, totalAmount: true },
    }),
    // G2g-4b: sell-side mirror of the procurement debitNotes query above — kept as its own
    // `salesDebitNotes` property (never renaming the existing `debitNotes` key, which stays the
    // procurement-side figure).
    tx.salesDebitNote.findMany({
      where: { companyId, debitNoteDate: { gte: start, lte: end }, status: { not: 'CANCELLED' } },
      select: { debitNoteNumber: true, totalAmount: true },
    }),
  ]);

  const byMode = new Map<string, number>();
  for (const p of payments) byMode.set(p.mode, (byMode.get(p.mode) ?? 0) + Number(p.amount));

  return {
    date: start,
    sales: {
      count: invoices.length,
      totalAmount: invoices.reduce((s, i) => s + Number(i.totalAmount), 0),
      rows: invoices.map((i) => ({ invoiceNumber: i.invoiceNumber, invoiceType: i.invoiceType, client: i.client.name, amount: Number(i.totalAmount) })),
    },
    payments: {
      count: payments.length,
      total: payments.reduce((s, p) => s + Number(p.amount), 0),
      byMode: Array.from(byMode.entries()).map(([mode, total]) => ({ mode, total })),
    },
    returns: {
      count: returns.length,
      totalAmount: returns.reduce((s, r) => s + Number(r.totalAmount), 0),
      rows: returns.map((r) => ({ returnNumber: r.returnNumber, amount: Number(r.totalAmount) })),
    },
    exchanges: {
      count: exchanges.length,
      totalAmount: exchanges.reduce((s, e) => s + Number(e.valuedAmount), 0),
      rows: exchanges.map((e) => ({ exchangeNumber: e.exchangeNumber, amount: Number(e.valuedAmount) })),
    },
    creditNotes: {
      count: creditNotes.length,
      totalAmount: creditNotes.reduce((s, cn) => s + Number(cn.totalAmount), 0),
      rows: creditNotes.map((cn) => ({ creditNoteNumber: cn.creditNoteNumber, amount: Number(cn.totalAmount) })),
    },
    debitNotes: {
      count: debitNotes.length,
      totalAmount: debitNotes.reduce((s, d) => s + Number(d.totalAmount), 0),
      rows: debitNotes.map((d) => ({ debitNoteNumber: d.debitNoteNumber, amount: Number(d.totalAmount) })),
    },
    // G2g-4b: sell-side Sales Debit Notes — a separate property from `debitNotes` (procurement),
    // per the instruction not to rename or repurpose that existing key.
    salesDebitNotes: {
      count: salesDebitNotes.length,
      totalAmount: salesDebitNotes.reduce((s, d) => s + Number(d.totalAmount), 0),
      rows: salesDebitNotes.map((d) => ({ debitNoteNumber: d.debitNoteNumber, amount: Number(d.totalAmount) })),
    },
  };
}

// H5: GST HSN-wise summary. InvoiceItem already carries its own companyId (Phase 1) so this
// scopes directly on the line, not just through a join to the invoice.
// G2g-1: reconciles with the actual sales GST accounting movement rather than independently
// recalculating GST from gross InvoiceItem.totalPrice. Four tax-moving sources, netted by HSN+rate
// exactly like getPurchaseGstSummary's own add(..., sign, ...) pattern (G2g-4b added #4):
//   1. InvoiceItem — uses its own persisted taxableValue/cgstAmount/sgstAmount/igstAmount (G1 Part D
//      snapshot), never totalPrice * taxRate — so an invoice-level discount, already folded into
//      that snapshot at sale time, is never double-counted or ignored here.
//   2. SalesReturnItem — has no persisted tax breakdown of its own (unlike PurchaseReturnItem), so
//      its tax-inclusive `amount` is split by the linked InvoiceItem's own snapshotted taxRate using
//      the exact same revenuePortion/taxPortion formula createSalesReturn() and
//      creditNote.service.ts's buildLineFromInvoiceItem() already use — not a new formula, the same
//      one, reapplied on the read side. Same-state/inter-state is read off that InvoiceItem's own
//      persisted cgstAmount (not re-resolved from the client's state), then split via the shared
//      splitGst(). A SalesReturn's own (Path A) CreditNote is never separately deducted below — its
//      GST was already reversed here, via the return.
//   3. CreditNoteItem — only a standalone (Path B — salesReturnId null) ISSUED note; its own
//      persisted taxableValue/cgstAmount/sgstAmount/igstAmount are used directly, same as InvoiceItem.
//      A CANCELLED note (its effect was already reversed at cancellation) and a Path A note (already
//      counted via its SalesReturn, #2 above) are both excluded.
//   4. SalesDebitNoteItem (G2g-4b) — an active (ISSUED) Sales Debit Note's own persisted
//      taxableValue/cgstAmount/sgstAmount/igstAmount, used directly like #3, but added with a
//      POSITIVE sign — it increases what was billed, the opposite of a Credit Note. A CANCELLED
//      note is excluded (its effect was undone at cancellation). This is an internal GST prep
//      enhancement only (CLAUDE.md note on this phase) — not the GSTR-1 reporting implementation.
// G2g-2: `opts` is additive and optional — every existing caller that passes only
// (companyId, from, to) keeps its prior company-wide, unfiltered behavior unchanged.
//   - branchId: caller has already verified (assertBranchAccessible) this branch belongs to the
//     company AND the caller may access it — this function trusts it as a plain filter.
//   - branchAccess: applied only when branchId is absent, and only when the caller is actually
//     restricted (allBranches: false) — an unrestricted caller with no explicit branchId still
//     sees the whole company, same as today.
//   - gstRegistrationId: caller has already verified (assertOwnedIfPresent) it belongs to the
//     company. Matched against TaxInvoice.sellerRegistrationId / CreditNote.sellerRegistrationId
//     — the persisted snapshot stamped at document-creation time (G1 Part E), never re-resolved.
//     A SalesReturn has no registration field of its own (CLAUDE.md/task instruction: do not add
//     one) — it derives its registration from the original invoice's own TaxInvoice instead.
export async function getGstSummary(
  companyId: string, from: Date, to: Date,
  opts?: { branchAccess?: BranchAccess; branchId?: string; gstRegistrationId?: string },
) {
  const allowedBranchIds = opts?.branchId
    ? [opts.branchId]
    : (opts?.branchAccess && !opts.branchAccess.allBranches ? opts.branchAccess.branchIds : undefined);
  const gstRegistrationId = opts?.gstRegistrationId;

  const [items, returnItems, creditNoteItems, salesDebitNoteItems, otherChargesInvoices] = await Promise.all([
    tenantQuery(companyId, (tx) =>
      tx.invoiceItem.findMany({
        // J3.5 Finding 1: a voided invoice's lines were never actually a taxable sale — exclude them
        // from GST prep (already documented in the UI as prep, not filing-ready, but still wrong to
        // include a reversed sale's lines at all).
        where: {
          companyId,
          invoice: {
            invoiceDate: { gte: from, lte: to }, currency: 'INR', status: { not: 'VOID' },
            ...(allowedBranchIds && { branchId: { in: allowedBranchIds } }),
            ...(gstRegistrationId && { taxDetails: { sellerRegistrationId: gstRegistrationId } }),
          },
        },
        select: {
          taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true, taxRate: true,
          hsnCode: { select: { code: true, description: true } },
          invoice: { select: { taxDetails: { select: { id: true } } } },
        },
      })
    ),
    // Netted by returnDate, the period a return's own GST reversal actually happened in — not the
    // original invoiceDate. Only against a taxable INR sale (a return on a non-INR/non-taxable
    // invoice has no GST to reverse — createSalesReturn itself forces taxRate to 0 in that case).
    tenantQuery(companyId, (tx) =>
      tx.salesReturnItem.findMany({
        where: {
          companyId,
          return: {
            returnDate: { gte: from, lte: to },
            invoice: {
              currency: 'INR',
              // A gstRegistrationId filter already implies "taxDetails exists and matches" — no
              // separate isNot: null needed alongside it (see istDate.ts-adjacent reasoning: a
              // field filter on a null relation naturally fails to match).
              taxDetails: gstRegistrationId ? { sellerRegistrationId: gstRegistrationId } : { isNot: null },
              ...(allowedBranchIds && { branchId: { in: allowedBranchIds } }),
            },
          },
        },
        select: {
          amount: true,
          invoiceItem: { select: { taxRate: true, cgstAmount: true, hsnCode: { select: { code: true, description: true } } } },
        },
      })
    ),
    tenantQuery(companyId, (tx) =>
      tx.creditNoteItem.findMany({
        where: {
          companyId,
          creditNote: {
            salesReturnId: null, status: 'ISSUED', creditNoteDate: { gte: from, lte: to },
            ...(gstRegistrationId && { sellerRegistrationId: gstRegistrationId }),
            ...(allowedBranchIds && { invoice: { branchId: { in: allowedBranchIds } } }),
          },
        },
        select: {
          taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true, taxRate: true,
          hsnCode: { select: { code: true, description: true } },
        },
      })
    ),
    // G2g-4b: an active (ISSUED, never CANCELLED) Sales Debit Note's own persisted
    // taxableValue/cgstAmount/sgstAmount/igstAmount, used directly like InvoiceItem/CreditNoteItem
    // above — a POSITIVE outward adjustment (it increases what was billed), the opposite sign of
    // creditNoteItems above. Branch is scoped via the debit note's own `branchId` column (it
    // carries one directly, unlike CreditNote).
    tenantQuery(companyId, (tx) =>
      tx.salesDebitNoteItem.findMany({
        where: {
          companyId,
          salesDebitNote: {
            status: 'ISSUED', debitNoteDate: { gte: from, lte: to },
            ...(gstRegistrationId && { sellerRegistrationId: gstRegistrationId }),
            ...(allowedBranchIds && { branchId: { in: allowedBranchIds } }),
          },
        },
        select: {
          taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true, taxRate: true,
          hsnCode: { select: { code: true, description: true } },
        },
      })
    ),
    // G2g-4a.2: SalesInvoice.otherCharges (shipping/packing/misc — priceInvoice()'s "Add & Less")
    // is taxable and folds into this same invoice's taxAmount/totalAmount, but has no InvoiceItem
    // row of its own (see priceInvoice()'s own comment — it is taxed at the default HSN rate,
    // invoice-wide, never attributed to any one line). The `items` query above therefore silently
    // excludes it from every HSN/rate row and from `totals` below — this query exists only to
    // surface that gap explicitly (see the `reconciliation` field on the return value), never to
    // fabricate an HSN-wise row for it. Same period/currency/status/branch/registration scope as
    // `items`' own nested `invoice: {...}` filter, applied directly here at the invoice level.
    tenantQuery(companyId, (tx) =>
      tx.salesInvoice.findMany({
        where: {
          companyId, invoiceDate: { gte: from, lte: to }, currency: 'INR', status: { not: 'VOID' },
          otherCharges: { not: 0 },
          ...(allowedBranchIds && { branchId: { in: allowedBranchIds } }),
          ...(gstRegistrationId && { taxDetails: { sellerRegistrationId: gstRegistrationId } }),
        },
        select: {
          id: true, otherCharges: true, taxAmount: true,
          items: { select: { lineTotalTax: true } },
        },
      })
    ),
  ]);

  type Row = { hsnCode: string; description: string | null; taxRate: number; taxableValue: number; cgst: number; sgst: number; igst: number };
  const byKey = new Map<string, Row>();
  const add = (hsn: { code: string; description: string | null } | null | undefined, rate: number, sign: 1 | -1,
    taxable: number, cgst: number, sgst: number, igst: number) => {
    const hsnCode = hsn?.code ?? 'UNKNOWN';
    const key = `${hsnCode}:${rate}`;
    const row = byKey.get(key) ?? { hsnCode, description: hsn?.description ?? null, taxRate: rate, taxableValue: 0, cgst: 0, sgst: 0, igst: 0 };
    row.taxableValue += sign * taxable; row.cgst += sign * cgst; row.sgst += sign * sgst; row.igst += sign * igst;
    byKey.set(key, row);
  };

  for (const item of items) {
    if (!item.invoice.taxDetails) continue; // no TaxInvoice = not a taxable INR sale (A1 invariant)
    add(item.hsnCode, Number(item.taxRate), 1, Number(item.taxableValue), Number(item.cgstAmount), Number(item.sgstAmount), Number(item.igstAmount));
  }

  for (const ri of returnItems) {
    const taxRate = Number(ri.invoiceItem.taxRate);
    const amount = Number(ri.amount);
    const taxableValue = amount / (1 + taxRate);
    const taxPortion = amount - taxableValue;
    const isSameState = Number(ri.invoiceItem.cgstAmount) > 0;
    const { cgst, sgst, igst } = splitGst(taxPortion, isSameState);
    add(ri.invoiceItem.hsnCode, taxRate, -1, taxableValue, cgst, sgst, igst);
  }

  for (const ci of creditNoteItems) {
    add(ci.hsnCode, Number(ci.taxRate), -1, Number(ci.taxableValue), Number(ci.cgstAmount), Number(ci.sgstAmount), Number(ci.igstAmount));
  }

  for (const di of salesDebitNoteItems) {
    add(di.hsnCode, Number(di.taxRate), 1, Number(di.taxableValue), Number(di.cgstAmount), Number(di.sgstAmount), Number(di.igstAmount));
  }

  const rows = Array.from(byKey.values()).sort((a, b) => a.hsnCode.localeCompare(b.hsnCode) || a.taxRate - b.taxRate);

  // G2g-4a.2: otherChargesTax is derived, not re-priced — invoice.taxAmount (persisted, the real
  // amount actually charged/posted) minus the sum of that same invoice's own InvoiceItem.lineTotalTax
  // (also persisted) is exactly the tax portion `items` above had no line to attribute to. This
  // never re-runs priceInvoice()'s own rate math (which could drift from what was actually billed)
  // and never guesses an HSN for otherCharges — it only reports that a real, non-zero gap exists.
  const otherChargesTaxableValue = round2(otherChargesInvoices.reduce((s, inv) => s + Number(inv.otherCharges), 0));
  const otherChargesTax = round2(otherChargesInvoices.reduce(
    (s, inv) => s + (Number(inv.taxAmount) - inv.items.reduce((ls, it) => ls + Number(it.lineTotalTax), 0)),
    0,
  ));
  const reconciliation = otherChargesInvoices.length > 0
    ? {
        diagnostic: 'OTHER_CHARGES_NOT_REPRESENTED' as const,
        invoiceCount: otherChargesInvoices.length,
        otherChargesTaxableValue,
        otherChargesTax,
        note: 'SalesInvoice.otherCharges (shipping/packing/misc) is taxable and included in these invoices\' own totals, but has no InvoiceItem/HSN representation, so it is excluded from the rows/totals above — never fabricated as an HSN-wise line. See CLAUDE.md G2g-4a.2.',
      }
    : null;

  return {
    from, to, rows,
    totals: {
      taxableValue: rows.reduce((s, r) => s + r.taxableValue, 0),
      cgst: rows.reduce((s, r) => s + r.cgst, 0),
      sgst: rows.reduce((s, r) => s + r.sgst, 0),
      igst: rows.reduce((s, r) => s + r.igst, 0),
      totalTax: rows.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0),
    },
    reconciliation,
  };
}

// Purchase-side GST (input tax credit) for a period — the mirror of getGstSummary. Reads the tax
// stamped on each GrnItem when it was tagged into stock (never recomputed from today's rates) and
// nets off purchase returns by the tax they reversed. `bills` groups by supplier invoice (the GRN's
// invoiceNumber) for matching against the supplier's filed GSTR-1 / your GSTR-2B. Prep, not a return.
// G2g-2: branch access only — no gstRegistrationId filter on this side. Every purchase document
// (GoodsReceiptNote/PoItem/DebitNote) persists a receiving BRANCH but no GST-registration identity
// of its own; the only authoritative registration relationship in the schema is Branch.gstRegistrationId,
// and it is itself optional (falls back to the company's primary registration at SALE time via
// resolveSellerRegistration — a resolution this purchase-side function has never run and that has no
// natural "as of GRN date" meaning here). Deriving a purchase-side registration filter from that would mean
// inventing a new resolution behavior in a phase explicitly scoped to reuse only what already exists —
// see the G2g-2 final report's Deviations section for the full reasoning.
export async function getPurchaseGstSummary(
  companyId: string, from: Date, to: Date,
  opts?: { branchAccess?: BranchAccess; branchId?: string },
) {
  const allowedBranchIds = opts?.branchId
    ? [opts.branchId]
    : (opts?.branchAccess && !opts.branchAccess.allBranches ? opts.branchAccess.branchIds : undefined);

  const [grnItems, returnItems, debitNoteItems] = await Promise.all([
    tenantQuery(companyId, (tx) => tx.grnItem.findMany({
      where: {
        companyId, taxableValue: { not: null },
        grn: { receivedDate: { gte: from, lte: to }, ...(allowedBranchIds && { branchId: { in: allowedBranchIds } }) },
      },
      select: {
        taxableValue: true, inputCgst: true, inputSgst: true, inputIgst: true,
        grn: { select: { id: true, grnNumber: true, invoiceNumber: true, invoiceDate: true, receivedDate: true } },
        poItem: { select: { taxRate: true, hsnCode: { select: { code: true, description: true } }, po: { select: { supplier: { select: { id: true, name: true, gstNumber: true } } } } } },
      },
    })),
    tenantQuery(companyId, (tx) => tx.purchaseReturnItem.findMany({
      where: {
        companyId, return: { returnDate: { gte: from, lte: to } },
        // Same dual GRN-vs-lot path the select below already reads from (a returned tag may have
        // come from a direct FINISHED_GOODS GRN line or from a FINISHED_LOT bag) — branch-scoped
        // by the intake GRN's own branch, consistent with how grnItems/debitNoteItems are scoped.
        ...(allowedBranchIds && {
          tag: {
            OR: [
              { grnItem: { grn: { branchId: { in: allowedBranchIds } } } },
              { purchaseLot: { grnItem: { grn: { branchId: { in: allowedBranchIds } } } } },
            ],
          },
        }),
      },
      select: {
        amount: true, cgst: true, sgst: true, igst: true,
        tag: { select: {
          grnItem: { select: { poItem: { select: { taxRate: true, hsnCode: { select: { code: true, description: true } } } } } },
          purchaseLot: { select: { grnItem: { select: { poItem: { select: { taxRate: true, hsnCode: { select: { code: true, description: true } } } } } } } },
        } },
      },
    })),
    // G2e (§7 point 2 of the design doc): a standalone (Path B) Debit Note moves ITC exactly like a
    // PurchaseReturnItem and must be netted off the same way. A Path A one is excluded
    // (purchaseReturnId: null below) — its ITC reversal is already counted via the PurchaseReturnItem
    // rows above; the DebitNote itself is only that return's document representation. Cancelled
    // notes are excluded — their ITC effect was undone at cancellation.
    tenantQuery(companyId, (tx) => tx.debitNoteItem.findMany({
      where: {
        companyId,
        debitNote: {
          purchaseReturnId: null, status: 'ISSUED', debitNoteDate: { gte: from, lte: to },
          ...(allowedBranchIds && { grn: { branchId: { in: allowedBranchIds } } }),
        },
      },
      select: {
        taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true, taxRate: true,
        hsnCode: { select: { code: true, description: true } },
      },
    })),
  ]);

  type Row = { hsnCode: string; description: string | null; taxRate: number; taxableValue: number; cgst: number; sgst: number; igst: number };
  const byKey = new Map<string, Row>();
  const add = (hsn: { code: string; description: string | null } | null | undefined, rate: number, sign: 1 | -1,
    taxable: number, cgst: number, sgst: number, igst: number) => {
    const hsnCode = hsn?.code ?? 'UNKNOWN';
    const key = `${hsnCode}:${rate}`;
    const row = byKey.get(key) ?? { hsnCode, description: hsn?.description ?? null, taxRate: rate, taxableValue: 0, cgst: 0, sgst: 0, igst: 0 };
    row.taxableValue += sign * taxable; row.cgst += sign * cgst; row.sgst += sign * sgst; row.igst += sign * igst;
    byKey.set(key, row);
  };

  type Bill = { grnNumber: string; supplierName: string; supplierGstin: string | null; invoiceNumber: string | null; invoiceDate: Date | null; receivedDate: Date; taxableValue: number; cgst: number; sgst: number; igst: number };
  const bills = new Map<string, Bill>();

  for (const i of grnItems) {
    const taxable = Number(i.taxableValue), cgst = Number(i.inputCgst), sgst = Number(i.inputSgst), igst = Number(i.inputIgst);
    add(i.poItem.hsnCode, Number(i.poItem.taxRate), 1, taxable, cgst, sgst, igst);
    const supplier = i.poItem.po.supplier;
    const bill = bills.get(i.grn.id) ?? {
      grnNumber: i.grn.grnNumber, supplierName: supplier.name, supplierGstin: supplier.gstNumber,
      invoiceNumber: i.grn.invoiceNumber, invoiceDate: i.grn.invoiceDate, receivedDate: i.grn.receivedDate,
      taxableValue: 0, cgst: 0, sgst: 0, igst: 0,
    };
    bill.taxableValue += taxable; bill.cgst += cgst; bill.sgst += sgst; bill.igst += igst;
    bills.set(i.grn.id, bill);
  }
  for (const r of returnItems) {
    const po = (r.tag.grnItem ?? r.tag.purchaseLot?.grnItem)?.poItem;
    add(po?.hsnCode, Number(po?.taxRate ?? 0), -1, Number(r.amount), Number(r.cgst), Number(r.sgst), Number(r.igst));
  }
  // G2e: standalone Debit Notes net off the same way — same `add(..., -1, ...)` pattern, own
  // stamped hsnCode/taxRate (never re-looked-up), no `bills` entry (they have no GRN line of their
  // own to attribute a bill-grouping row to; §16 of the task deliberately doesn't ask for one).
  for (const d of debitNoteItems) {
    add(d.hsnCode, Number(d.taxRate), -1, Number(d.taxableValue), Number(d.cgstAmount), Number(d.sgstAmount), Number(d.igstAmount));
  }

  const rows = Array.from(byKey.values()).sort((a, b) => a.hsnCode.localeCompare(b.hsnCode) || a.taxRate - b.taxRate);
  const sum = (k: 'taxableValue' | 'cgst' | 'sgst' | 'igst') => rows.reduce((s, r) => s + r[k], 0);
  return {
    from, to, rows,
    bills: Array.from(bills.values()).sort((a, b) => a.receivedDate.getTime() - b.receivedDate.getTime()),
    totals: {
      taxableValue: sum('taxableValue'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst'),
      totalTax: sum('cgst') + sum('sgst') + sum('igst'),
    },
  };
}

// Template/copy pattern — same shape as RoleTemplate -> Role (see the multi-tenant blueprint's
// Role-uniqueness correction for why: a plain nullable-companyId "global template" row can't
// express "at most one platform template per code" without a hand-written partial index, so
// each company instead gets its OWN literal copy of these 35 accounts, upserted by
// (companyId, code)). Called once per company at creation time; NOT auto-re-synced into
// existing companies later if this template list changes — same explicit, documented choice as
// seedCompanyRoles(), for the same reason (a company may have already customized its own copy).
export async function seedChartOfAccounts(
  companyId: string,
  client?: Prisma.TransactionClient | typeof prisma,
  accounts: StarterAccount[] = getStarterPackage().chartOfAccounts,
): Promise<void> {
  if (!client) return tenantTransaction(companyId, (tx) => seedChartOfAccounts(companyId, tx, accounts));
  // The chart itself is defined once, in the versioned TRIVO Starter Package (this function is a
  // thin idempotent applier for callers — tests, the seed — that only want the chart). Provisioning
  // applies the whole package, including this chart, in one transaction.
  for (const acc of accounts) {
    await client.account.upsert({
      where: { companyId_code: { companyId, code: acc.code } },
      create: { ...acc, companyId },
      update: { name: acc.name },
    });
  }
}
