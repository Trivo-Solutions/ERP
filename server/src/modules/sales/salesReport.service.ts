import { Prisma } from '@prisma/client';
import { tenantQuery, tenantBatch, TenantContext, canAccessBranch } from '../../shared/tenantContext';
import { assertBranchAccessible } from '../../middleware/tenant';
import { AppError } from '../../middleware/error';

// Sales Report — Summary (one row per invoice) and Detailed (one row per invoice line, credited to the employee who
// made that sale). Read-only aggregation over SalesInvoice / InvoiceItem; it prices nothing and posts nothing.
//
// Attribution rule (Detailed, and "who is on this invoice" in Summary):
//   a line's employee = InvoiceItem.salesPersonId, else the invoice's own SalesInvoice.salesPersonId, else "Unassigned".
// Nothing is inferred from the estimate, the invoice's creator, the logged-in user or the customer.
//
// Voided invoices are never a completed sale and are excluded (same rule as getSalesRegister / the other J3.5 reports).

export const SALES_REPORT_ROW_LIMIT = 5000;
export const PAYMENT_STATUSES = ['PAID', 'PARTIAL', 'UNPAID'] as const;
const EPS = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (d: unknown) => Number(d ?? 0);

export interface SalesReportFilters {
  from?: Date; to?: Date;               // invoice dates, both ends inclusive (calendar days)
  branchId?: string; invoiceNo?: string; customer?: string;
  salesPersonId?: string; paymentStatus?: string; status?: string;
}

async function scope(ctx: TenantContext, f: SalesReportFilters) {
  if (f.branchId) await assertBranchAccessible(f.branchId, ctx);
  if (f.paymentStatus && !(PAYMENT_STATUSES as readonly string[]).includes(f.paymentStatus)) {
    throw new AppError('Invalid payment status filter', 400);
  }
  const toExclusive = f.to && new Date(f.to.getTime() + 24 * 60 * 60 * 1000);
  // A branch-restricted caller is capped to their own branches even when no branch was asked for.
  const branchFilter = f.branchId ? f.branchId : (ctx.branchAccess.allBranches ? undefined : { in: ctx.branchAccess.branchIds });

  const and: Prisma.SalesInvoiceWhereInput[] = [];
  if (f.customer?.trim()) {
    const q = f.customer.trim();
    and.push({ client: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { clientCode: { contains: q, mode: 'insensitive' } }] } });
  }
  if (f.salesPersonId) {
    // Header OR any line — the invoice is still one row/one invoice however many of its lines match.
    and.push({ OR: [{ salesPersonId: f.salesPersonId }, { items: { some: { salesPersonId: f.salesPersonId } } }] });
  }
  if (f.paymentStatus === 'PAID') and.push({ balanceDue: { lte: EPS } });
  if (f.paymentStatus === 'PARTIAL') and.push({ paidAmount: { gt: EPS }, balanceDue: { gt: EPS } });
  if (f.paymentStatus === 'UNPAID') and.push({ paidAmount: { lte: EPS }, balanceDue: { gt: EPS } });

  const where: Prisma.SalesInvoiceWhereInput = {
    companyId: ctx.companyId,
    status: f.status ? { equals: f.status, not: 'VOID' } : { not: 'VOID' },
    ...((f.from || toExclusive) && { invoiceDate: { ...(f.from && { gte: f.from }), ...(toExclusive && { lt: toExclusive }) } }),
    ...(branchFilter && { branchId: branchFilter }),
    ...(f.invoiceNo?.trim() && { invoiceNumber: { contains: f.invoiceNo.trim(), mode: 'insensitive' } }),
    ...(and.length > 0 && { AND: and }),
  };
  return where;
}

// Picker lists the caller may use, so the screen needs no second round trip.
async function pickers(ctx: TenantContext) {
  const [branches, members] = await tenantBatch(ctx.companyId, (tx) => [
    tx.branch.findMany({ where: { companyId: ctx.companyId, isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    tx.companyUser.findMany({ where: { companyId: ctx.companyId, isActive: true }, select: { userId: true, user: { select: { name: true } } } }),
  ]);
  return {
    branches: branches.filter((b) => canAccessBranch(ctx, b.id)),
    employees: members.map((m) => ({ id: m.userId, name: m.user.name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Names for the employee ids that appear on rows — only members of THIS company are ever resolved.
async function employeeNames(ctx: TenantContext, ids: string[]) {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return new Map<string, string>();
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.companyUser.findMany({
    where: { companyId: ctx.companyId, userId: { in: unique } }, select: { userId: true, user: { select: { name: true } } },
  }));
  return new Map(rows.map((r) => [r.userId, r.user.name]));
}

const paymentStatusOf = (paid: number, due: number) => (due <= EPS ? 'PAID' : paid > EPS ? 'PARTIAL' : 'UNPAID');

// ───────────────────────────── Summary: 1 invoice = 1 row ─────────────────────────────

export async function getSalesSummary(ctx: TenantContext, filters: SalesReportFilters = {}) {
  const where = await scope(ctx, filters);

  const [invoices, agg, taxAgg, pick] = await Promise.all([
    tenantQuery(ctx.companyId, (tx) => tx.salesInvoice.findMany({
      where, orderBy: [{ invoiceDate: 'desc' }, { invoiceNumber: 'desc' }], take: SALES_REPORT_ROW_LIMIT + 1,
      select: {
        id: true, invoiceNumber: true, invoiceDate: true, createdAt: true, status: true, currency: true,
        subtotal: true, discountAmount: true, otherCharges: true, taxAmount: true, totalAmount: true, paidAmount: true, balanceDue: true,
        salesPersonId: true,
        client: { select: { clientCode: true, name: true } }, branch: { select: { id: true, name: true } },
        taxDetails: { select: { taxableAmount: true, cgst: true, sgst: true, igst: true } },
      },
    })),
    // Footer totals come from the database over the whole filtered set (not just the rows sent back), one row per invoice.
    tenantQuery(ctx.companyId, (tx) => tx.salesInvoice.aggregate({
      where, _count: { _all: true }, _sum: { subtotal: true, discountAmount: true, otherCharges: true, taxAmount: true, totalAmount: true },
    })),
    tenantQuery(ctx.companyId, (tx) => tx.taxInvoice.aggregate({
      where: { companyId: ctx.companyId, invoice: where }, _sum: { taxableAmount: true, cgst: true, sgst: true, igst: true }, _count: { _all: true },
    })),
    pickers(ctx),
  ]);

  const truncated = invoices.length > SALES_REPORT_ROW_LIMIT;
  const page = truncated ? invoices.slice(0, SALES_REPORT_ROW_LIMIT) : invoices;
  const ids = page.map((i) => i.id);

  // Which employees each invoice's lines are credited to (one grouped query; a null group = lines that inherit the header).
  const lineGroups = ids.length === 0 ? [] : await tenantQuery(ctx.companyId, (tx) => tx.invoiceItem.groupBy({
    by: ['invoiceId', 'salesPersonId'], where: { companyId: ctx.companyId, invoiceId: { in: ids } },
  }));
  const employeesByInvoice = new Map<string, Set<string>>();
  for (const g of lineGroups) if (g.salesPersonId) (employeesByInvoice.get(g.invoiceId) ?? employeesByInvoice.set(g.invoiceId, new Set()).get(g.invoiceId)!).add(g.salesPersonId);
  const names = await employeeNames(ctx, [
    ...lineGroups.map((g) => g.salesPersonId).filter((x): x is string => !!x), ...page.map((i) => i.salesPersonId).filter((x): x is string => !!x),
  ]);

  const rows = page.map((inv) => {
    const set = new Set(employeesByInvoice.get(inv.id) ?? []);
    if (inv.salesPersonId) set.add(inv.salesPersonId); // the bill owner always counts as on the invoice
    const taxable = inv.taxDetails ? num(inv.taxDetails.taxableAmount) : round2(num(inv.subtotal) + num(inv.otherCharges) - num(inv.discountAmount));
    const paid = num(inv.paidAmount), due = num(inv.balanceDue);
    return {
      id: inv.id, invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, createdAt: inv.createdAt,
      customer: `${inv.client.clientCode} — ${inv.client.name}`, branch: inv.branch.name,
      salesEmployees: Array.from(set).map((id) => names.get(id) ?? 'Former employee').sort((a, b) => a.localeCompare(b)),
      taxableAmount: taxable, cgst: num(inv.taxDetails?.cgst), sgst: num(inv.taxDetails?.sgst), igst: num(inv.taxDetails?.igst),
      gstTotal: num(inv.taxAmount), invoiceTotal: num(inv.totalAmount),
      paymentStatus: paymentStatusOf(paid, due), invoiceStatus: inv.status, currency: inv.currency,
    };
  });

  // Invoices with no GST record (non-INR) contribute their own taxable base; the rest come from TaxInvoice, so the
  // taxable total reconciles with what each row shows.
  const invoiceCount = agg._count._all;
  const taxableTotal = num(taxAgg._sum.taxableAmount) + await taxlessTaxable(ctx, where);

  return {
    rows, branches: pick.branches, employeeOptions: pick.employees, truncated, limit: SALES_REPORT_ROW_LIMIT,
    totals: {
      invoiceCount, taxableAmount: round2(taxableTotal),
      cgst: round2(num(taxAgg._sum.cgst)), sgst: round2(num(taxAgg._sum.sgst)), igst: round2(num(taxAgg._sum.igst)),
      gstTotal: round2(num(agg._sum.taxAmount)), invoiceTotal: round2(num(agg._sum.totalAmount)),
    },
  };
}

// Taxable base of the (non-INR) invoices that have no TaxInvoice row: subtotal + other charges − discount, summed in the database.
async function taxlessTaxable(ctx: TenantContext, where: Prisma.SalesInvoiceWhereInput) {
  const a = await tenantQuery(ctx.companyId, (tx) => tx.salesInvoice.aggregate({
    where: { AND: [where, { taxDetails: { is: null } }] }, _sum: { subtotal: true, otherCharges: true, discountAmount: true },
  }));
  return num(a._sum.subtotal) + num(a._sum.otherCharges) - num(a._sum.discountAmount);
}

// ───────────────────────────── Detailed: invoice → employee → line ─────────────────────────────

export const UNASSIGNED = 'Unassigned';

export async function getSalesDetailed(ctx: TenantContext, filters: SalesReportFilters = {}) {
  const invoiceWhere = await scope(ctx, filters);
  // With an employee filter, only the lines credited to that employee (line's own, else — for a line left blank — the header).
  const lineWhere: Prisma.InvoiceItemWhereInput = {
    companyId: ctx.companyId, invoice: invoiceWhere,
    ...(filters.salesPersonId && {
      OR: [{ salesPersonId: filters.salesPersonId }, { salesPersonId: null, invoice: { salesPersonId: filters.salesPersonId } }],
    }),
  };

  const [lines, pick] = await Promise.all([
    tenantQuery(ctx.companyId, (tx) => tx.invoiceItem.findMany({
      where: lineWhere, take: SALES_REPORT_ROW_LIMIT + 1,
      orderBy: [{ invoice: { invoiceDate: 'desc' } }, { invoiceId: 'asc' }, { id: 'asc' }],
      select: {
        id: true, invoiceId: true, productCode: true, description: true, quantity: true, grossWeight: true, netGoldWeight: true,
        totalPrice: true, taxableValue: true, lineTotalTax: true, salesPersonId: true,
        karat: true, huid: true, stoneWeight: true, rateType: true, goldRate: true, makingCharge: true, wastagePercent: true, stoneValue: true,
        unitPrice: true, lineDiscountAmount: true, taxRate: true, cgstAmount: true, sgstAmount: true, igstAmount: true, uqc: true, materialBreakdown: true,
        tag: {
          select: {
            costPrice: true, makeType: true, settingType: true, collection: { select: { name: true } }, subCategory: { select: { name: true } },
            stockType: { select: { name: true } }, size: { select: { name: true } }, manufacturer: { select: { name: true } },
          },
        },
        category: { select: { name: true } }, hsnCode: { select: { code: true } },
        returnItems: { select: { amount: true } },
        invoice: {
          select: {
            invoiceNumber: true, invoiceDate: true, createdAt: true, status: true, salesPersonId: true,
            subtotal: true, discountAmount: true, otherCharges: true, taxAmount: true, roundOff: true, totalAmount: true,
            client: { select: { clientCode: true, name: true } }, branch: { select: { name: true } },
          },
        },
      },
    })),
    pickers(ctx),
  ]);

  const truncated = lines.length > SALES_REPORT_ROW_LIMIT;
  const page = truncated ? lines.slice(0, SALES_REPORT_ROW_LIMIT) : lines;
  const invoiceIds = Array.from(new Set(page.map((l) => l.invoiceId)));

  // Reconciliation base: EVERY line of each invoice shown (all employees, not just the filtered one), summed in the database.
  const sums = invoiceIds.length === 0 ? [] : await tenantQuery(ctx.companyId, (tx) => tx.invoiceItem.groupBy({
    by: ['invoiceId'], where: { companyId: ctx.companyId, invoiceId: { in: invoiceIds } },
    _sum: { totalPrice: true, taxableValue: true, lineTotalTax: true }, _count: { _all: true },
  }));
  const sumByInvoice = new Map(sums.map((s) => [s.invoiceId, s]));

  const names = await employeeNames(ctx, page.flatMap((l) => [l.salesPersonId, l.invoice.salesPersonId]).filter((x): x is string => !!x));

  // Pre-G1 lines never stored their own taxable/tax split (0 = "not computed"): spread the invoice's own figures over
  // them by value, so old invoices still report, instead of showing a zero line against a real total.
  const legacy = (invoiceId: string) => {
    const s = sumByInvoice.get(invoiceId);
    return !!s && num(s._sum.taxableValue) === 0 && num(s._sum.totalPrice) > 0;
  };

  type Detail = ReturnType<typeof buildRow>;
  const buildRow = (l: (typeof page)[number]) => {
    const inv = l.invoice;
    const effectiveId = l.salesPersonId ?? inv.salesPersonId;
    const s = sumByInvoice.get(l.invoiceId);
    const price = num(l.totalPrice);
    let taxable = num(l.taxableValue), gst = num(l.lineTotalTax);
    if (legacy(l.invoiceId) && num(s?._sum.totalPrice) > 0) {
      const share = price / num(s!._sum.totalPrice);
      taxable = round2((num(inv.subtotal) - num(inv.discountAmount)) * share);
      gst = round2(num(inv.taxAmount) * share);
    }
    const lineTotal = round2(taxable + gst);
    // Material split of the line: from the bill's own breakdown when it has one, else from the stored per-unit figures.
    const bd = (l.materialBreakdown ?? null) as { rows?: Array<{ materialType: string; weight: number; rate: number }>; mcRate?: number; vaPercent?: number } | null;
    const qty = l.quantity;
    let metalWt = 0, metalValue = 0, mcAmount = 0, vaAmount = 0, vaPercent = num(l.wastagePercent), mcRate = 0, stoneCost = 0;
    if (bd && Array.isArray(bd.rows)) {
      const metal = bd.rows.filter((r) => r.materialType === 'METAL');
      metalWt = metal.reduce((a, r) => a + num(r.weight), 0);
      metalValue = metal.reduce((a, r) => a + num(r.weight) * num(r.rate), 0);
      mcRate = num(bd.mcRate); vaPercent = num(bd.vaPercent);
      mcAmount = metalWt * mcRate; vaAmount = metalValue * vaPercent / 100;
      stoneCost = bd.rows.filter((r) => r.materialType !== 'METAL').reduce((a, r) => a + num(r.weight) * num(r.rate), 0);
    } else {
      metalWt = num(l.netGoldWeight) * qty;
      metalValue = l.rateType === 'FIXED' ? 0 : num(l.netGoldWeight) * num(l.goldRate) * qty;
      mcAmount = num(l.makingCharge) * qty; vaAmount = metalValue * vaPercent / 100;
      mcRate = num(l.netGoldWeight) > 0 ? num(l.makingCharge) / num(l.netGoldWeight) : 0;
      stoneCost = num(l.stoneValue) * qty;
    }
    const metalRate = metalWt > 0 ? metalValue / metalWt : 0;
    const returnedAmount = round2(l.returnItems.reduce((a, r) => a + num(r.amount), 0));
    return {
      id: l.id, invoiceId: l.invoiceId, invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, createdAt: inv.createdAt,
      branch: inv.branch.name, customer: `${inv.client.clientCode} — ${inv.client.name}`,
      salesEmployeeId: effectiveId ?? null,
      salesEmployee: effectiveId ? (names.get(effectiveId) ?? 'Former employee') : UNASSIGNED,
      attributedBy: l.salesPersonId ? 'LINE' : inv.salesPersonId ? 'INVOICE' : 'NONE',
      jewelCode: l.productCode, description: l.description, category: l.category?.name ?? '', hsn: l.hsnCode?.code ?? '',
      quantity: l.quantity, grossWeight: num(l.grossWeight), netWeight: num(l.netGoldWeight),
      karat: l.karat ?? '', huid: l.huid ?? '', stoneWeight: num(l.stoneWeight) * qty,
      subCategory: l.tag?.subCategory?.name ?? '', collection: l.tag?.collection?.name ?? '', stockType: l.tag?.stockType?.name ?? '',
      makeType: l.tag?.makeType ?? '', settingType: l.tag?.settingType ?? '', size: l.tag?.size?.name ?? '', manufacturer: l.tag?.manufacturer?.name ?? '',
      metalRate: round2(metalRate), metalValue: round2(metalValue), mcRate: round2(mcRate), mcAmount: round2(mcAmount),
      vaPercent: round2(vaPercent), vaAmount: round2(vaAmount), stoneValue: round2(stoneCost),
      grossAmount: round2(price), discount: num(l.lineDiscountAmount), taxRate: round2(num(l.taxRate) * 100),
      cgst: num(l.cgstAmount), sgst: num(l.sgstAmount), igst: num(l.igstAmount), uqc: l.uqc ?? '',
      costPrice: l.tag ? num(l.tag.costPrice) : null,
      taxableAmount: taxable, gst, lineTotal,
      returnedAmount, netTotal: round2(lineTotal - returnedAmount),
      lineStatus: returnedAmount > EPS ? 'RETURNED' : 'SOLD', invoiceStatus: inv.status,
    };
  };
  const rows: Detail[] = page.map(buildRow).sort((a, b) =>
    b.invoiceDate.getTime() - a.invoiceDate.getTime() || a.invoiceNumber.localeCompare(b.invoiceNumber)
      || a.salesEmployee.localeCompare(b.salesEmployee) || a.jewelCode.localeCompare(b.jewelCode));

  // Employee totals: an invoice with two employees contributes to both, but the invoice itself is counted once per employee.
  const byEmployee = new Map<string, { salesEmployeeId: string | null; salesEmployee: string; invoices: Set<string>; lines: number; taxableAmount: number; gst: number; salesAmount: number; returnedAmount: number }>();
  for (const r of rows) {
    const key = r.salesEmployeeId ?? UNASSIGNED;
    const e = byEmployee.get(key) ?? { salesEmployeeId: r.salesEmployeeId, salesEmployee: r.salesEmployee, invoices: new Set<string>(), lines: 0, taxableAmount: 0, gst: 0, salesAmount: 0, returnedAmount: 0 };
    e.invoices.add(r.invoiceId); e.lines += 1; e.taxableAmount += r.taxableAmount; e.gst += r.gst; e.salesAmount += r.lineTotal; e.returnedAmount += r.returnedAmount;
    byEmployee.set(key, e);
  }
  const employees = Array.from(byEmployee.values()).map((e) => ({
    salesEmployeeId: e.salesEmployeeId, salesEmployee: e.salesEmployee, invoiceCount: e.invoices.size, lineCount: e.lines,
    taxableAmount: round2(e.taxableAmount), gst: round2(e.gst), salesAmount: round2(e.salesAmount),
    returnedAmount: round2(e.returnedAmount), netSalesAmount: round2(e.salesAmount - e.returnedAmount),
  })).sort((a, b) => b.salesAmount - a.salesAmount);

  // Invoice-level reconciliation: invoice total = what the lines allocate + what no line carries (other charges, the GST
  // on them, round-off). Whatever is left is `difference` — normally 0, never hidden when it isn't.
  const invoiceMeta = new Map(page.map((l) => [l.invoiceId, l.invoice]));
  const reconciliation = invoiceIds.map((id) => {
    const inv = invoiceMeta.get(id)!;
    const s = sumByInvoice.get(id)!;
    const leg = legacy(id);
    const lineTax = leg ? num(inv.taxAmount) : num(s._sum.lineTotalTax);
    const lineTaxable = leg ? num(inv.subtotal) - num(inv.discountAmount) : num(s._sum.taxableValue);
    const allocatedTotal = round2(lineTaxable + lineTax);
    const nonLineAmount = round2(num(inv.otherCharges) + (num(inv.taxAmount) - lineTax) + num(inv.roundOff));
    const invoiceTotal = num(inv.totalAmount);
    const difference = round2(invoiceTotal - allocatedTotal - nonLineAmount);
    return {
      invoiceId: id, invoiceNumber: inv.invoiceNumber, invoiceTotal, allocatedTotal, nonLineAmount, difference,
      hasDiscrepancy: Math.abs(difference) > 0.01 * (num(s._count._all) + 2),
    };
  }).sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));

  return {
    rows, employees, reconciliation, branches: pick.branches, employeeOptions: pick.employees, truncated, limit: SALES_REPORT_ROW_LIMIT,
    totals: {
      invoiceCount: invoiceIds.length, lineCount: rows.length,
      taxableAmount: round2(rows.reduce((a, r) => a + r.taxableAmount, 0)), gst: round2(rows.reduce((a, r) => a + r.gst, 0)),
      salesAmount: round2(rows.reduce((a, r) => a + r.lineTotal, 0)), returnedAmount: round2(rows.reduce((a, r) => a + r.returnedAmount, 0)),
      invoiceTotal: round2(reconciliation.reduce((a, r) => a + r.invoiceTotal, 0)),
      allocatedTotal: round2(reconciliation.reduce((a, r) => a + r.allocatedTotal, 0)),
      nonLineAmount: round2(reconciliation.reduce((a, r) => a + r.nonLineAmount, 0)),
      difference: round2(reconciliation.reduce((a, r) => a + r.difference, 0)),
      discrepancyCount: reconciliation.filter((r) => r.hasDiscrepancy).length,
    },
  };
}
