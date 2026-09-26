import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { nextDocumentNumber } from '../../shared/numberSequence';
import { tenantQuery, tenantBatch, tenantTransaction, TenantContext } from '../../shared/tenantContext';
import { assertOwnedByCompany } from '../../middleware/tenant';
import { CREDIT_SETTLEMENT_MODES } from '../../shared/constants';
import { getStarterPackage, type StarterAccount } from '../platform/starterPackage';

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
      where: { companyId, balanceDue: { gt: 0 } },
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

  const [invoices, payments, returns, exchanges] = await tenantBatch(ctx.companyId, (tx) => [
    tx.salesInvoice.findMany({
      where: { companyId: ctx.companyId, clientId },
      select: { id: true, invoiceNumber: true, invoiceDate: true, totalAmount: true, createdAt: true },
    }),
    tx.invoicePayment.findMany({
      // Not OLD_GOLD / STORE_CREDIT: those settle a bill out of credit already shown above as the exchange / return
      // row, so listing them as receipts too would credit the customer twice.
      where: { companyId: ctx.companyId, clientId, mode: { notIn: CREDIT_SETTLEMENT_MODES } },
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

  const [bought, returns, payments] = await tenantBatch(ctx.companyId, (tx) => [
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
      where: { companyId: ctx.companyId, supplierId },
      select: { paymentNumber: true, paymentDate: true, amount: true, mode: true, createdAt: true },
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

  const [invoices, payments, returns, exchanges] = await tenantBatch(companyId, (tx) => [
    tx.salesInvoice.findMany({
      where: { companyId, invoiceDate: { gte: start, lte: end } },
      select: { invoiceNumber: true, invoiceType: true, totalAmount: true, client: { select: { name: true } } },
    }),
    tx.invoicePayment.findMany({
      // Money received only — old gold / store credit settlements are already in the exchanges / returns below.
      where: { companyId, paymentDate: { gte: start, lte: end }, mode: { notIn: CREDIT_SETTLEMENT_MODES } },
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
  };
}

// H5: GST HSN-wise summary. InvoiceItem already carries its own companyId (Phase 1) so this
// scopes directly on the line, not just through a join to the invoice.
export async function getGstSummary(companyId: string, from: Date, to: Date) {
  const items = await tenantQuery(companyId, (tx) =>
    tx.invoiceItem.findMany({
      where: { companyId, invoice: { invoiceDate: { gte: from, lte: to }, currency: 'INR' } },
      select: {
        totalPrice: true, taxRate: true,
        hsnCode: { select: { code: true, description: true } },
        invoice: { select: { taxDetails: { select: { igst: true } } } },
      },
    })
  );

  type Row = { hsnCode: string; description: string | null; taxRate: number; taxableValue: number; cgst: number; sgst: number; igst: number };
  const byKey = new Map<string, Row>();

  for (const item of items) {
    if (!item.invoice.taxDetails) continue; // no TaxInvoice = not a taxable INR sale (A1 invariant)
    const hsnCode = item.hsnCode?.code ?? 'UNKNOWN';
    const taxRate = Number(item.taxRate);
    const key = `${hsnCode}:${taxRate}`;
    const taxableValue = Number(item.totalPrice);
    const taxAmount = taxableValue * taxRate;
    const isInterState = Number(item.invoice.taxDetails.igst) > 0;

    const row = byKey.get(key) ?? { hsnCode, description: item.hsnCode?.description ?? null, taxRate, taxableValue: 0, cgst: 0, sgst: 0, igst: 0 };
    row.taxableValue += taxableValue;
    if (isInterState) row.igst += taxAmount;
    else { row.cgst += taxAmount / 2; row.sgst += taxAmount / 2; }
    byKey.set(key, row);
  }

  const rows = Array.from(byKey.values()).sort((a, b) => a.hsnCode.localeCompare(b.hsnCode) || a.taxRate - b.taxRate);
  return {
    from, to, rows,
    totals: {
      taxableValue: rows.reduce((s, r) => s + r.taxableValue, 0),
      cgst: rows.reduce((s, r) => s + r.cgst, 0),
      sgst: rows.reduce((s, r) => s + r.sgst, 0),
      igst: rows.reduce((s, r) => s + r.igst, 0),
      totalTax: rows.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0),
    },
  };
}

// Purchase-side GST (input tax credit) for a period — the mirror of getGstSummary. Reads the tax
// stamped on each GrnItem when it was tagged into stock (never recomputed from today's rates) and
// nets off purchase returns by the tax they reversed. `bills` groups by supplier invoice (the GRN's
// invoiceNumber) for matching against the supplier's filed GSTR-1 / your GSTR-2B. Prep, not a return.
export async function getPurchaseGstSummary(companyId: string, from: Date, to: Date) {
  const [grnItems, returnItems] = await Promise.all([
    tenantQuery(companyId, (tx) => tx.grnItem.findMany({
      where: { companyId, taxableValue: { not: null }, grn: { receivedDate: { gte: from, lte: to } } },
      select: {
        taxableValue: true, inputCgst: true, inputSgst: true, inputIgst: true,
        grn: { select: { id: true, grnNumber: true, invoiceNumber: true, invoiceDate: true, receivedDate: true } },
        poItem: { select: { taxRate: true, hsnCode: { select: { code: true, description: true } }, po: { select: { supplier: { select: { id: true, name: true, gstNumber: true } } } } } },
      },
    })),
    tenantQuery(companyId, (tx) => tx.purchaseReturnItem.findMany({
      where: { companyId, return: { returnDate: { gte: from, lte: to } } },
      select: {
        amount: true, cgst: true, sgst: true, igst: true,
        tag: { select: {
          grnItem: { select: { poItem: { select: { taxRate: true, hsnCode: { select: { code: true, description: true } } } } } },
          purchaseLot: { select: { grnItem: { select: { poItem: { select: { taxRate: true, hsnCode: { select: { code: true, description: true } } } } } } } },
        } },
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
