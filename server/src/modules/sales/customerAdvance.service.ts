import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { assertCashLimit } from '../../shared/compliance';
import { nextDocumentNumber, gstFinancialYear } from '../../shared/numberSequence';
import { LEDGER_ACCOUNT, cashOrBankAccount } from '../../shared/ledgerAccounts';
import { postAutoJournalEntry } from '../finance/finance.service';
import { TenantContext, tenantTransaction, tenantQuery } from '../../shared/tenantContext';
import { assertBranchAccessible, assertOwnedByCompany } from '../../middleware/tenant';
import { applyPayment } from './sales.service';
import { lockAdvances, loadSpendableAdvance } from './customerAdvanceApply';
import { PAYMENT_MODE_CUSTOMER_ADVANCE } from '../../shared/constants';

// Customer Advances, Phase 2: money received before any invoice. A LIABILITY (ledger 2400) — never AR, never
// Client.currentBalance, never Store Credit, never an InvoicePayment. Applying one to an invoice is Phase 3 (bottom of this file).

export const ADVANCE_MODES = ['CASH', 'CARD', 'UPI', 'BANK_TRANSFER', 'CHEQUE'] as const;
export const MAX_PAYMENT_LINES = 10;
export const SPLIT_MODE = 'SPLIT'; // customer_advances.mode when the receipt was paid in more than one mode
export type AdvanceStatus = 'ACTIVE' | 'PARTIALLY_APPLIED' | 'FULLY_APPLIED' | 'REFUNDED' | 'REVERSED';
const ADVANCE_STATUSES: AdvanceStatus[] = ['ACTIVE', 'PARTIALLY_APPLIED', 'FULLY_APPLIED', 'REFUNDED', 'REVERSED'];

// Money in integer paise so sums never pick up float drift.
const paise = (d: Prisma.Decimal | number | string) => Math.round(Number(d) * 100);
const rupees = (p: number) => p / 100;

export function deriveAdvanceStatus(a: { amount: Prisma.Decimal; appliedAmount: Prisma.Decimal; refundedAmount: Prisma.Decimal; reversedAt: Date | null }): AdvanceStatus {
  if (a.reversedAt) return 'REVERSED';
  const amount = paise(a.amount); const applied = paise(a.appliedAmount); const refunded = paise(a.refundedAmount);
  if (refunded > 0 && applied + refunded >= amount) return 'REFUNDED';
  if (applied >= amount) return 'FULLY_APPLIED';
  if (applied > 0) return 'PARTIALLY_APPLIED';
  return 'ACTIVE';
}

const advanceInclude = {
  client: { select: { id: true, name: true, clientCode: true, phone: true } },
  branch: { select: { id: true, name: true, branchCode: true } },
  createdBy: { select: { id: true, name: true } },
  reversedBy: { select: { id: true, name: true } },
  payments: { select: { id: true, mode: true, amount: true, referenceNo: true }, orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.CustomerAdvanceInclude;

type AdvanceRow = Prisma.CustomerAdvanceGetPayload<{ include: typeof advanceInclude }>;

// The only shape ever sent to a caller: derived status + available, no company id / idempotency key.
function present(a: AdvanceRow) {
  const status = deriveAdvanceStatus(a);
  const available = status === 'REVERSED' ? 0 : rupees(paise(a.amount) - paise(a.appliedAmount) - paise(a.refundedAmount));
  return {
    id: a.id, advanceNumber: a.advanceNumber, advanceDate: a.advanceDate,
    client: a.client, branch: a.branch,
    amount: Number(a.amount), appliedAmount: Number(a.appliedAmount), refundedAmount: Number(a.refundedAmount),
    availableAmount: available, mode: a.mode, referenceNo: a.referenceNo, notes: a.notes,
    payments: a.payments.map((p) => ({ id: p.id, mode: p.mode, amount: Number(p.amount), referenceNo: p.referenceNo })),
    createdBy: a.createdBy, createdAt: a.createdAt, status,
    reversedAt: a.reversedAt, reversedBy: a.reversedBy, reversalReason: a.reversalReason,
  };
}
export type AdvanceView = ReturnType<typeof present>;

export type AdvancePaymentInput = { mode: string; amount: number; referenceNo?: string };

// Validates and normalises the payment lines (a mode may repeat, e.g. two UPI payments), each > 0 with at most 2 decimals.
function normalisePayments(data: { amount?: number; mode?: string; referenceNo?: string; payments?: AdvancePaymentInput[] }) {
  const raw = Array.isArray(data.payments) && data.payments.length > 0
    ? data.payments
    : [{ mode: data.mode as string, amount: data.amount as number, referenceNo: data.referenceNo }];
  if (raw.length > MAX_PAYMENT_LINES) throw new AppError(`At most ${MAX_PAYMENT_LINES} payment lines`, 400);
  return raw.map((r) => {
    const amount = typeof r?.amount === 'string' ? Number(r.amount) : r?.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw new AppError('Advance amount must be greater than zero', 400);
    // Money is stored to the paisa — refuse more precision rather than silently round a customer's money.
    if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) throw new AppError('Advance amount cannot have more than 2 decimal places', 400);
    const mode = String(r.mode ?? '').trim().toUpperCase();
    if (!(ADVANCE_MODES as readonly string[]).includes(mode)) throw new AppError(`Payment mode must be one of ${ADVANCE_MODES.join(', ')}`, 400);
    const referenceNo = r.referenceNo ? String(r.referenceNo).trim().slice(0, 120) || undefined : undefined;
    return { mode, amount, referenceNo: mode === 'CASH' ? undefined : referenceNo };
  });
}

// Debit lines for the receipt: modes collapse to their ledger account (cash vs bank).
function ledgerAmounts(lines: { mode: string; amount: number }[]) {
  const byAccount = new Map<string, number>();
  for (const l of lines) {
    const code = cashOrBankAccount(l.mode);
    byAccount.set(code, (byAccount.get(code) ?? 0) + paise(l.amount));
  }
  return [...byAccount].map(([accountCode, p]) => ({ accountCode, amount: rupees(p) }));
}

export async function createCustomerAdvance(
  data: { clientId: string; branchId: string; amount?: number; mode?: string; referenceNo?: string; payments?: AdvancePaymentInput[]; notes?: string; idempotencyKey?: string },
  ctx: TenantContext, userId: string,
): Promise<{ advance: AdvanceView; replayed: boolean }> {
  for (const k of ['clientId', 'branchId'] as const) {
    if (typeof data[k] !== 'string' || !data[k]) throw new AppError(`${k} is required`, 400);
  }
  // `payments` is the split form; the plain amount + mode form is a single line.
  const lines = normalisePayments(data);
  const amount = rupees(lines.reduce((sum, l) => sum + paise(l.amount), 0));
  const mode = lines.length === 1 ? lines[0].mode : SPLIT_MODE;
  const idempotencyKey = data.idempotencyKey ? String(data.idempotencyKey).trim().slice(0, 120) || undefined : undefined;
  const referenceNo = lines.length === 1 ? lines[0].referenceNo : undefined;
  const notes = data.notes ? String(data.notes).trim() || undefined : undefined;

  await assertOwnedByCompany('client', data.clientId, ctx.companyId, 'Client');
  await assertBranchAccessible(data.branchId, ctx, 'Branch');
  const client = await tenantQuery(ctx.companyId, (tx) => tx.client.findUnique({ where: { id: data.clientId }, select: { isActive: true, name: true } }));
  if (!client) throw new AppError('Client not found', 404);
  if (!client.isActive) throw new AppError(`${client.name} is deactivated and cannot receive new transactions`, 409);

  const findByKey = () => idempotencyKey
    ? tenantQuery(ctx.companyId, (tx) => tx.customerAdvance.findFirst({ where: { companyId: ctx.companyId, idempotencyKey }, include: advanceInclude }))
    : Promise.resolve(null);
  const replay = (existing: AdvanceRow) => {
    // Same key reused for a different request is a client bug, not a retry — never hand back the wrong record.
    const sig = (xs: { mode: string; amount: Prisma.Decimal | number }[]) => xs.map((x) => `${x.mode}:${paise(x.amount)}`).sort().join(",");
    const sameLines = sig(existing.payments) === sig(lines);
    if (existing.clientId !== data.clientId || paise(existing.amount) !== paise(amount) || existing.mode !== mode || !sameLines) {
      throw new AppError('This idempotency key was already used for a different advance', 409);
    }
    return { advance: present(existing), replayed: true };
  };
  const prior = await findByKey();
  if (prior) return replay(prior);

  let created: AdvanceRow;
  try {
    created = await tenantTransaction(ctx.companyId, async (tx) => {
      const advanceDate = new Date();
      // Sec 269ST counts only the cash part of a split receipt.
      const cashPart = rupees(lines.filter((l) => l.mode === 'CASH').reduce((sum, l) => sum + paise(l.amount), 0));
      if (cashPart > 0) await assertCashLimit(tx, ctx.companyId, data.clientId, { paymentDate: advanceDate, amount: cashPart, mode: 'CASH' });
      const advanceNumber = await nextDocumentNumber(ctx.companyId, 'ADV', 'ADV', tx, gstFinancialYear(advanceDate));
      const row = await tx.customerAdvance.create({
        data: {
          companyId: ctx.companyId, branchId: data.branchId, clientId: data.clientId, advanceNumber, advanceDate,
          amount, mode, referenceNo, notes, createdById: userId, idempotencyKey,
          payments: { create: lines.map((l) => ({ mode: l.mode, amount: l.amount, referenceNo: l.referenceNo })) },
        },
        include: advanceInclude,
      });
      await postAutoJournalEntry(tx, ctx.companyId, {
        date: advanceDate, description: `Customer advance ${advanceNumber}`,
        referenceType: 'CustomerAdvance', referenceId: row.id, userId,
        lines: [
          ...ledgerAmounts(lines).map((l) => ({ accountCode: l.accountCode, debit: l.amount })),
          { accountCode: LEDGER_ACCOUNT.CUSTOMER_ADVANCES, credit: amount },
        ],
      });
      return row;
    });
  } catch (err) {
    // A concurrent request with the same key won the unique index: that is the replay, not an error.
    if (idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await findByKey();
      if (winner) return replay(winner);
    }
    throw err;
  }

  await createAuditEntry('customer_advances', created.id, userId, 'CREATE', undefined, {
    advanceNumber: created.advanceNumber, clientId: created.clientId, customer: created.client.name,
    amount, mode, payments: lines.map((l) => ({ mode: l.mode, amount: l.amount })), branchId: created.branchId, branch: created.branch.name,
  }, ctx.companyId);
  return { advance: present(created), replayed: false };
}

export async function getCustomerAdvance(ctx: TenantContext, id: string) {
  const row = await tenantQuery(ctx.companyId, (tx) => tx.customerAdvance.findFirst({ where: { id: String(id), companyId: ctx.companyId }, include: advanceInclude }));
  // A branch the caller can't see is reported exactly like a missing record.
  if (!row || !(ctx.branchAccess.allBranches || ctx.branchAccess.branchIds.includes(row.branchId))) throw new AppError('Advance not found', 404);
  return present(row);
}

export interface AdvanceFilters {
  dateFrom?: Date; dateTo?: Date; clientId?: string; branchId?: string; advanceNumber?: string;
  mode?: string; createdById?: string; status?: string;
}

export async function listCustomerAdvances(ctx: TenantContext, f: AdvanceFilters) {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const status = str(f.status)?.toUpperCase();
  if (status && !ADVANCE_STATUSES.includes(status as AdvanceStatus)) throw new AppError('Unknown status filter', 400);
  const branchId = str(f.branchId);
  const scope = ctx.branchAccess.allBranches ? undefined : { in: ctx.branchAccess.branchIds };
  if (branchId && scope && !scope.in.includes(branchId)) throw new AppError('Branch not found', 404);
  const mode = str(f.mode)?.toUpperCase();

  const where: Prisma.CustomerAdvanceWhereInput = {
    companyId: ctx.companyId,
    ...(branchId ? { branchId } : scope ? { branchId: scope } : {}),
    ...(str(f.clientId) && { clientId: str(f.clientId) }),
    ...(str(f.createdById) && { createdById: str(f.createdById) }),
    ...(mode && (mode === SPLIT_MODE ? { mode } : { payments: { some: { mode } } })),
    ...(str(f.advanceNumber) && { advanceNumber: { contains: str(f.advanceNumber), mode: 'insensitive' } }),
    ...((f.dateFrom || f.dateTo) && { advanceDate: { ...(f.dateFrom && { gte: f.dateFrom }), ...(f.dateTo && { lt: f.dateTo }) } }),
  };
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.customerAdvance.findMany({ where, include: advanceInclude, orderBy: { advanceDate: 'desc' }, take: 5000 }));
  const creators = await tenantQuery(ctx.companyId, (tx) => tx.customerAdvance.findMany({
    where: { companyId: ctx.companyId, ...(scope && { branchId: scope }) }, distinct: ['createdById'], select: { createdBy: { select: { id: true, name: true } } },
  }));

  const branches = await tenantQuery(ctx.companyId, (tx) => tx.branch.findMany({
    where: { companyId: ctx.companyId, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' },
  }));

  // Status is derived (no stored column), so it is filtered here and totals are summed over EVERY matching row,
  // never just the rows a page happens to show. Reversed advances stay listed but hold no money.
  const data = rows.map(present).filter((r) => !status || r.status === status);
  const live = data.filter((r) => r.status !== 'REVERSED');
  const sum = (pick: (r: AdvanceView) => number) => rupees(live.reduce((s, r) => s + paise(pick(r)), 0));
  return {
    rows: data,
    totals: {
      count: live.length, reversedCount: data.length - live.length,
      amount: sum((r) => r.amount), applied: sum((r) => r.appliedAmount), available: sum((r) => r.availableAmount),
    },
    createdByOptions: creators.map((c) => c.createdBy),
    // The branches this caller may receive into / filter by (the dialog and filter bar need them, and
    // /sales/branches is gated on invoice:create, which a cashier recording advances may not hold).
    branchOptions: branches.filter((b) => ctx.branchAccess.allBranches || ctx.branchAccess.branchIds.includes(b.id)),
  };
}

export async function reverseCustomerAdvance(id: string, ctx: TenantContext, userId: string, reason: string) {
  if (typeof reason !== 'string' || !reason.trim()) throw new AppError('A reason is required to reverse an advance', 400);
  await getCustomerAdvance(ctx, id); // 404 for another company's or an unauthorised branch's advance

  const before = await tenantTransaction(ctx.companyId, async (tx) => {
    // Lock first so a concurrent application (Phase 3) or second reversal serialises behind this one.
    await tx.$queryRaw`SELECT "id" FROM "customer_advances" WHERE "id" = ${id} FOR UPDATE`;
    const adv = await tx.customerAdvance.findUniqueOrThrow({ where: { id }, include: { payments: true } });
    if (adv.reversedAt) throw new AppError('This advance has already been reversed', 409);
    if (paise(adv.appliedAmount) > 0) throw new AppError('This advance has already been applied to an invoice and cannot be reversed', 409);
    if (paise(adv.refundedAmount) > 0) throw new AppError('This advance has been refunded and cannot be reversed', 409);

    // Count-checked claim: the predicate repeats the eligibility rules, so a state change after the read still fails.
    const claimed = await tx.customerAdvance.updateMany({
      where: { id, companyId: ctx.companyId, reversedAt: null, appliedAmount: 0, refundedAmount: 0 },
      data: { reversedAt: new Date(), reversedById: userId, reversalReason: reason.trim() },
    });
    if (claimed.count !== 1) throw new AppError('This advance could not be reversed — it was changed by another operation', 409);

    const amount = Number(adv.amount);
    await postAutoJournalEntry(tx, ctx.companyId, {
      date: new Date(), description: `Reversal of customer advance ${adv.advanceNumber}`,
      referenceType: 'CustomerAdvanceReversal', referenceId: adv.id, userId,
      lines: [
        { accountCode: LEDGER_ACCOUNT.CUSTOMER_ADVANCES, debit: amount },
        // Pay back through the accounts the money came in by.
        ...ledgerAmounts(adv.payments.length ? adv.payments.map((p) => ({ mode: p.mode, amount: Number(p.amount) })) : [{ mode: adv.mode, amount }]).map((l) => ({ accountCode: l.accountCode, credit: l.amount })),
      ],
    });
    return adv;
  });

  await createAuditEntry('customer_advances', id, userId, 'REVERSE',
    { advanceNumber: before.advanceNumber, amount: Number(before.amount), mode: before.mode, status: 'ACTIVE' },
    { status: 'REVERSED', reason: reason.trim(), reversedAt: new Date().toISOString() }, ctx.companyId);
  return getCustomerAdvance(ctx, id);
}

// ─── Phase 3: applying advances to an invoice ────────────────────────────────────────────────────────────────────

// What the bill screen offers: this customer's advances that still hold money, oldest first. Deliberately NOT
// narrowed to the caller's branches — an advance taken at Branch A can be spent at Branch B; only the company and
// the customer scope it. Amounts come from the server's own rows, never from Client.currentBalance.
export async function listAvailableAdvances(ctx: TenantContext, clientId: string) {
  await assertOwnedByCompany('client', clientId, ctx.companyId, 'Client');
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.customerAdvance.findMany({
    where: { companyId: ctx.companyId, clientId, reversedAt: null },
    include: advanceInclude, orderBy: [{ advanceDate: 'asc' }, { createdAt: 'asc' }],
  }));
  const advances = rows.map(present).filter((a) => a.availableAmount > 0);
  return { advances, totalAvailable: rupees(advances.reduce((s, a) => s + paise(a.availableAmount), 0)) };
}

export type AdvanceAllocation = { advanceId: string; amount: number };
type AppliedLine = { advanceId: string; advanceNumber: string; amount: number; paymentNumber: string };

// Applies one or more of the invoice customer's advances to an existing invoice, in one transaction. Reuses
// applyPayment (the invoice's own paid/due/status maths, PMT numbering, ledger and customer balance) rather than a
// parallel engine. Either explicit `allocations` (partial use of each is fine) or `auto: true` — oldest advances
// first — and in both cases every spend is its own CustomerAdvanceApplication naming its own advance.
// Lock order matches reverseInvoicePayment: invoice, then advances (by id).
export async function applyCustomerAdvance(
  invoiceId: string,
  req: { allocations?: AdvanceAllocation[]; auto?: boolean; maxAmount?: number; idempotencyKey?: string },
  ctx: TenantContext, userId: string,
) {
  if (typeof invoiceId !== 'string' || !invoiceId) throw new AppError('invoiceId is required', 400);
  const idemBase = req.idempotencyKey ? String(req.idempotencyKey).trim().slice(0, 100) || undefined : undefined;
  const explicit = req.allocations ?? [];
  if (!req.auto && (!Array.isArray(explicit) || explicit.length === 0)) throw new AppError('Choose at least one advance to apply', 400);
  for (const a of explicit) {
    if (typeof a?.advanceId !== 'string' || !a.advanceId) throw new AppError('advanceId is required', 400);
    if (typeof a.amount !== 'number' || !Number.isFinite(a.amount) || a.amount <= 0 || Math.abs(a.amount * 100 - Math.round(a.amount * 100)) > 1e-6) {
      throw new AppError('Each amount must be greater than zero with at most 2 decimal places', 400);
    }
  }
  if (new Set(explicit.map((a) => a.advanceId)).size !== explicit.length) throw new AppError('Each advance can appear once per request', 400);
  const cap = req.maxAmount == null ? undefined : paise(req.maxAmount);
  if (cap !== undefined && !(cap > 0)) throw new AppError('Amount must be greater than zero', 400);

  await assertOwnedByCompany('salesInvoice', invoiceId, ctx.companyId, 'Invoice');
  const head = await tenantQuery(ctx.companyId, (tx) => tx.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { branchId: true } }));
  // The application belongs to the invoice's branch: the caller must have access to it (not to the advance's origin).
  if (head.branchId) await assertBranchAccessible(head.branchId, ctx, 'Invoice');

  const out = await tenantTransaction(ctx.companyId, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "sales_invoices" WHERE "id" = ${invoiceId} AND "companyId" = ${ctx.companyId} FOR UPDATE`;
    let invoice = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (invoice.status === 'VOID') throw new AppError('This invoice has been voided and cannot receive a payment', 409);
    if (invoice.currency !== 'INR') throw new AppError('Customer advances can only be applied to a rupee invoice', 400);

    // Retry of a request already applied: the invoice lock above makes this read race-free.
    if (idemBase) {
      const prior = await tx.customerAdvanceApplication.count({
        where: { companyId: ctx.companyId, invoiceId, idempotencyKey: { startsWith: `${idemBase}:` } },
      });
      if (prior > 0) return { replayed: true, applied: [] as AppliedLine[], invoice };
    }

    let outstanding = paise(invoice.totalAmount) - paise(invoice.paidAmount);
    if (outstanding <= 0) throw new AppError('This invoice has nothing outstanding to apply an advance to', 409);
    let budget = cap ?? Number.POSITIVE_INFINITY;

    let plan: AdvanceAllocation[];
    if (req.auto) {
      const open = await tx.customerAdvance.findMany({
        where: { companyId: ctx.companyId, clientId: invoice.clientId, reversedAt: null },
        orderBy: [{ advanceDate: 'asc' }, { createdAt: 'asc' }], select: { id: true },
      });
      plan = open.map((o) => ({ advanceId: o.id, amount: Number.POSITIVE_INFINITY }));
    } else {
      plan = explicit;
    }
    await lockAdvances(tx, ctx.companyId, plan.map((p) => p.advanceId));

    const applied: AppliedLine[] = [];
    for (const step of plan) {
      if (outstanding <= 0 || budget <= 0) break;
      let spendable: Awaited<ReturnType<typeof loadSpendableAdvance>>;
      try {
        spendable = await loadSpendableAdvance(tx, ctx.companyId, step.advanceId, invoice.clientId);
      } catch (e) {
        if (req.auto) continue; // an advance emptied since the list was read is simply skipped in auto mode
        throw e;
      }
      const take = Math.min(Number.isFinite(step.amount) ? paise(step.amount) : Infinity, paise(spendable.remaining), outstanding, budget);
      if (!(take > 0)) continue;
      const amount = rupees(take);
      const res = await applyPayment(tx, ctx.companyId, invoice, { paymentDate: new Date(), amount, mode: PAYMENT_MODE_CUSTOMER_ADVANCE }, userId,
        { advanceId: step.advanceId, idempotencyKey: idemBase ? `${idemBase}:${step.advanceId}` : undefined });
      invoice = { ...invoice, paidAmount: res.paidAmount as never };
      const app = await tx.customerAdvanceApplication.findFirstOrThrow({
        where: { companyId: ctx.companyId, invoiceId, advanceId: step.advanceId, reversedAt: null }, orderBy: { appliedAt: 'desc' },
        select: { invoicePayment: { select: { paymentNumber: true } } },
      });
      applied.push({ advanceId: step.advanceId, advanceNumber: spendable.adv.advanceNumber, amount, paymentNumber: app.invoicePayment.paymentNumber });
      outstanding -= take; budget -= take;
    }
    if (applied.length === 0) throw new AppError('No advance balance could be applied', 409);
    return { replayed: false, applied, invoice: await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId } }) };
  });

  // Audited after the transaction is durable (createAuditEntry writes on its own connection).
  for (const a of out.applied) {
    await createAuditEntry('customer_advances', a.advanceId, userId, 'APPLY', undefined,
      { advanceNumber: a.advanceNumber, invoiceId, invoiceNumber: out.invoice.invoiceNumber, amount: a.amount, paymentNumber: a.paymentNumber }, ctx.companyId);
  }
  const inv = out.invoice;
  return {
    replayed: out.replayed, applied: out.applied,
    totalApplied: rupees(out.applied.reduce((s, a) => s + paise(a.amount), 0)),
    invoice: { id: inv.id, invoiceNumber: inv.invoiceNumber, totalAmount: Number(inv.totalAmount), paidAmount: Number(inv.paidAmount), balanceDue: Number(inv.balanceDue), status: inv.status },
  };
}

// Application history for the advance detail view (invoice, amounts, branch where it was spent, reversal state).
export async function listAdvanceApplications(ctx: TenantContext, advanceId: string) {
  await getCustomerAdvance(ctx, advanceId); // 404 for another company's / an unauthorised branch's advance
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.customerAdvanceApplication.findMany({
    where: { companyId: ctx.companyId, advanceId }, orderBy: { appliedAt: 'desc' },
    include: {
      invoice: { select: { id: true, invoiceNumber: true, invoiceDate: true, branch: { select: { id: true, name: true } } } },
      appliedBy: { select: { id: true, name: true } },
    },
  }));
  return rows.map((r) => ({
    id: r.id, invoice: r.invoice, amount: Number(r.amount), appliedAt: r.appliedAt, appliedBy: r.appliedBy,
    reversedAt: r.reversedAt, reversalReason: r.reversalReason,
  }));
}
