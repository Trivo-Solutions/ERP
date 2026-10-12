import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { cleanupJournalEntries } from './ledger';
import { PERMISSION_CATALOG } from '../shared/permissionCatalog';
import { createInvoice, createSalesReturn, recordPayment } from '../modules/sales/sales.service';
import { createGstRegistration } from '../modules/company/company.service';
import { tenantQuery } from '../shared/tenantContext';
import { resolveFilingPeriodMmYYYY } from '../modules/finance/gst/gstr3bReporting.service';
import { getFinancialYearForDate } from '../shared/financialYear';

// "Delete bill" over real HTTP: POST /sales/invoices/:id/delete (permission invoice:delete). It reverses every live receipt
// and then voids the bill - never a raw row delete - so these tests check the OUTCOME the user cares about (stock back on the
// shelf, ledger and customer balance back where they were, the bill kept on record as VOID) as well as who may do it.
describe('HTTP: delete bill (invoice:delete)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tenants: TestTenant[] = [];
  const clientIds: string[] = [];
  const invoiceIds: string[] = [];
  const tagIds: string[] = [];
  const regs: Array<{ id: string; companyId: string }> = [];
  let n = 0;

  afterAll(async () => {
    // GST filing fixtures (periods / snapshots / attempts) are FORCE-RLS: remove them, then the registration they point at.
    for (const r of regs) {
      const periods = await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.findMany({ where: { gstRegistrationId: r.id }, select: { id: true } }));
      const ids = periods.map((p) => p.id);
      if (ids.length > 0) {
        await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.updateMany({ where: { id: { in: ids } }, data: { filedSnapshotId: null, filedByAttemptId: null } }));
        await tenantQuery(r.companyId, (tx) => tx.gstFilingAttempt.deleteMany({ where: { returnPeriodId: { in: ids } } }));
        await tenantQuery(r.companyId, (tx) => tx.gstFilingSnapshot.deleteMany({ where: { returnPeriodId: { in: ids } } }));
        await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.deleteMany({ where: { id: { in: ids } } }));
      }
    }
    const pays = await prisma.invoicePayment.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } });
    const rets = await prisma.salesReturn.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } });
    await cleanupJournalEntries([...invoiceIds, ...pays.map((p) => p.id), ...rets.map((r) => r.id)]);
    await prisma.repairCase.deleteMany({ where: { salesReturnItem: { return: { clientId: { in: clientIds } } } } });
    await prisma.salesReturn.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.branch.updateMany({ where: { companyId: { in: regs.map((r) => r.companyId) } }, data: { gstRegistrationId: null } });
    for (const r of regs) {
      await tenantQuery(r.companyId, (tx) => tx.companyGstAatoHistory.deleteMany({ where: { gstRegistrationId: r.id } }));
      await tenantQuery(r.companyId, (tx) => tx.companyGstAato.deleteMany({ where: { gstRegistrationId: r.id } }));
      await tenantQuery(r.companyId, (tx) => tx.companyGstRegistration.deleteMany({ where: { id: r.id } }));
    }
    for (const t of tenants) await cleanupTestTenant(t);
    for (const t of tenants) await prisma.user.deleteMany({ where: { email: t.user.email } });
    await prisma.$disconnect();
  });

  async function tenantWith(tag: string, permissions: string[]) {
    const t = await createTestTenant(`${tag}${suffix}`, permissions);
    tenants.push(t);
    return { t, api: apiWith(tokenFor(t), app) };
  }

  // A bill of one tagged piece (FIXED rate 100 + 3% GST = 103), optionally paid in cash in the same request.
  async function makeBill(t: TestTenant, o: { paid?: boolean } = {}) {
    const i = n++;
    const client = await prisma.client.create({
      data: { companyId: t.company.id, clientCode: `TSTCL-DEL-${i}-${suffix}`, name: `Client ${i}`, panNumber: 'ABCDE1234F', type: 'RETAIL' },
    });
    clientIds.push(client.id);
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-DEL-${suffix}-${i}`, companyId: t.company.id, branchId: t.branch.id, name: 'Ring', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 1, netWeight: 1, stoneWeight: 0, costPrice: 60, sellingPrice: 103, createdById: t.user.id,
      },
    });
    tagIds.push(tag.id);
    // Sales are made through the service (no permission check) so the permission under test is the only variable.
    const bill = await createInvoice({
      clientId: client.id, branchId: t.branch.id, invoiceDate: new Date(), invoiceType: 'RETAIL',
      items: [{ productCode: tag.tagNumber, description: 'Ring', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 100, makingCharge: 0, tagId: tag.id }],
      ...(o.paid ? { payments: [{ mode: 'CASH', amount: 103, paymentDate: new Date() }] } : {}),
    } as any, t.ctx, t.user.id);
    invoiceIds.push(bill.id);
    return { invoiceId: bill.id as string, clientId: client.id, tagId: tag.id };
  }

  const balanceOf = async (clientId: string) => Number((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentBalance);
  const invoiceOf = (id: string) => prisma.salesInvoice.findUniqueOrThrow({ where: { id } });
  const tagStatus = async (id: string) => (await prisma.jewelryTag.findUniqueOrThrow({ where: { id } })).status;

  it('requires authentication, a reason, and the invoice:delete permission (void / reverse alone are not enough)', async () => {
    const owner = await tenantWith('PM', ['invoice:delete']);
    const bill = await makeBill(owner.t);

    expect((await apiWith(undefined, app).post(`/sales/invoices/${bill.invoiceId}/delete`, { reason: 'test' })).status).toBe(401);

    const voidOnly = await tenantWith('PV', ['invoice:void', 'payment:reverse', 'invoice:edit']);
    const vb = await makeBill(voidOnly.t);
    expect((await voidOnly.api.post(`/sales/invoices/${vb.invoiceId}/delete`, { reason: 'test' })).status).toBe(403);
    const none = await tenantWith('PN', ['sales:view']);
    const nb = await makeBill(none.t);
    expect((await none.api.post(`/sales/invoices/${nb.invoiceId}/delete`, { reason: 'test' })).status).toBe(403);
    for (const b of [vb, nb]) expect((await invoiceOf(b.invoiceId)).status).not.toBe('VOID');

    // a reason is mandatory
    expect((await owner.api.post(`/sales/invoices/${bill.invoiceId}/delete`, {})).status).toBe(400);
    expect((await owner.api.post(`/sales/invoices/${bill.invoiceId}/delete`, { reason: '  ' })).status).toBe(400);
    expect((await invoiceOf(bill.invoiceId)).status).not.toBe('VOID');
  });

  it('a Super Admin (all permissions) and a delegated user can both delete', async () => {
    const admin = await tenantWith('SA', ['*']);
    const a = await makeBill(admin.t);
    expect((await admin.api.post(`/sales/invoices/${a.invoiceId}/delete`, { reason: 'entered by mistake' })).status).toBe(200);
    const delegate = await tenantWith('DL', ['invoice:delete']);
    const d = await makeBill(delegate.t);
    expect((await delegate.api.post(`/sales/invoices/${d.invoiceId}/delete`, { reason: 'duplicate bill' })).status).toBe(200);
    expect((await invoiceOf(a.invoiceId)).status).toBe('VOID');
    expect((await invoiceOf(d.invoiceId)).status).toBe('VOID');
  });

  it('an unpaid bill: stock back on the shelf, customer balance back to zero, bill kept as VOID, audited', async () => {
    const { t, api } = await tenantWith('UP', ['invoice:delete']);
    const bill = await makeBill(t);
    expect(await tagStatus(bill.tagId)).toBe('SOLD');
    expect(await balanceOf(bill.clientId)).toBeCloseTo(103, 2);

    const res = await api.post(`/sales/invoices/${bill.invoiceId}/delete`, { reason: 'test bill' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'VOID', reversedPayments: 0 });

    expect(await tagStatus(bill.tagId)).toBe('IN_STOCK');
    expect(await balanceOf(bill.clientId)).toBeCloseTo(0, 2);
    const inv = await invoiceOf(bill.invoiceId);
    expect(inv.status).toBe('VOID');
    expect(inv.voidedById).toBe(t.user.id);

    // the ledger is reversed, not erased: the original entry stays, a void entry is added, and every entry balances
    const entries = await prisma.journalEntry.findMany({ where: { referenceId: bill.invoiceId }, include: { lines: true } });
    expect(entries.map((e) => e.referenceType).sort()).toEqual(['SalesInvoice', 'SalesInvoiceVoid']);
    for (const e of entries) {
      const dr = e.lines.reduce((s, l) => s + Number(l.debit), 0); const cr = e.lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(dr).toBeCloseTo(cr, 2);
    }

    // audit: a DELETE entry by this user, in this company, carrying the reason and the before/after
    const audit = await prisma.auditLog.findMany({ where: { tableName: 'sales_invoices', recordId: bill.invoiceId, action: 'DELETE' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ companyId: t.company.id, userId: t.user.id });
    expect(JSON.stringify(audit[0].newValues)).toContain('test bill');
    expect(JSON.stringify(audit[0].newValues)).toContain('administrativeOverride');

    // it cannot be deleted twice
    expect((await api.post(`/sales/invoices/${bill.invoiceId}/delete`, { reason: 'again' })).status).toBe(409);
  });

  it('a paid bill: the receipt is reversed first (cash back out, invoice reopened), then the bill is voided', async () => {
    const { t, api } = await tenantWith('PD', ['invoice:delete']);
    const bill = await makeBill(t, { paid: true });
    expect(await balanceOf(bill.clientId)).toBeCloseTo(0, 2); // sold 103, paid 103

    const res = await api.post(`/sales/invoices/${bill.invoiceId}/delete`, { reason: 'test sale in production' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.reversedPayments).toBe(1);

    const pays = await prisma.invoicePayment.findMany({ where: { invoiceId: bill.invoiceId } });
    expect(pays).toHaveLength(1);                       // the receipt row is flagged, never erased
    expect(pays[0].reversedAt).not.toBeNull();
    expect(pays[0].reversedById).toBe(t.user.id);
    expect(pays[0].reversalReason).toContain('test sale in production');
    expect((await invoiceOf(bill.invoiceId)).status).toBe('VOID');
    expect(await tagStatus(bill.tagId)).toBe('IN_STOCK');
    expect(await balanceOf(bill.clientId)).toBeCloseTo(0, 2);

    // cash account nets to zero across the sale, the receipt and both reversals
    const lines = await prisma.journalLine.findMany({
      where: { entry: { companyId: t.company.id, OR: [{ referenceId: bill.invoiceId }, { referenceId: pays[0].id }] } },
      include: { account: { select: { code: true } } },
    });
    const net = (code: string) => lines.filter((l) => l.account.code === code).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    const byCode = new Set(lines.map((l) => l.account.code));
    for (const code of byCode) expect(net(code), `account ${code} should net to zero`).toBeCloseTo(0, 2);
  });

  it('a bill with a return is refused up front - nothing is reversed or changed', async () => {
    const { t, api } = await tenantWith('RT', ['invoice:delete']);
    const bill = await makeBill(t, { paid: true });
    const inv = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: bill.invoiceId }, include: { items: true } });
    await createSalesReturn({ invoiceId: bill.invoiceId, items: [{ invoiceItemId: inv.items[0].id }], reason: 'customer returned' }, t.ctx, t.user.id);

    const res = await api.post(`/sales/invoices/${bill.invoiceId}/delete`, { reason: 'try' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/return/i);
    const pays = await prisma.invoicePayment.findMany({ where: { invoiceId: bill.invoiceId } });
    expect(pays.every((p) => p.reversedAt === null)).toBe(true); // the receipt was NOT reversed as a side effect
    expect((await invoiceOf(bill.invoiceId)).status).not.toBe('VOID');
  });

  it('another company cannot delete this bill (404, nothing changes); unknown ids are a clean 404', async () => {
    const a = await tenantWith('XA', ['invoice:delete']);
    const b = await tenantWith('XB', ['invoice:delete']);
    const bill = await makeBill(a.t, { paid: true });

    expect((await b.api.post(`/sales/invoices/${bill.invoiceId}/delete`, { reason: 'attack' })).status).toBe(404);
    expect((await b.api.post(`/sales/invoices/c${'0'.repeat(24)}/delete`, { reason: 'testing' })).status).toBe(404); // well-formed, nonexistent
    expect((await b.api.post('/sales/invoices/not-an-id/delete', { reason: 'testing' })).status).toBe(404); // malformed
    expect((await invoiceOf(bill.invoiceId)).status).not.toBe('VOID');
    const pays = await prisma.invoicePayment.findMany({ where: { invoiceId: bill.invoiceId } });
    expect(pays.every((p) => p.reversedAt === null)).toBe(true);
    expect(await tagStatus(bill.tagId)).toBe('SOLD');
  });

  // ── Atomicity: a delete is ONE transaction. Every test below compares the COMPLETE persisted state before and after. ──
  async function stateOf(t: TestTenant, b: { invoiceId: string; clientId: string; tagId: string }) {
    const pays = await prisma.invoicePayment.findMany({ where: { invoiceId: b.invoiceId }, orderBy: { id: 'asc' } });
    const inv = await invoiceOf(b.invoiceId);
    const refs = [b.invoiceId, ...pays.map((p) => p.id)];
    return {
      payments: pays.map((p) => [p.id, p.reversedAt ? 'reversed' : 'live']),
      status: inv.status, paid: Number(inv.paidAmount), due: Number(inv.balanceDue), voidedAt: inv.voidedAt,
      tag: await tagStatus(b.tagId), clientBalance: await balanceOf(b.clientId),
      journalEntries: await prisma.journalEntry.count({ where: { companyId: t.company.id, referenceId: { in: refs } } }),
      reversalAudits: await prisma.auditLog.count({ where: { companyId: t.company.id, action: { in: ['REVERSE', 'VOID', 'DELETE'] }, recordId: { in: refs } } }),
    };
  }
  const reversalAudits = async (t: TestTenant, invoiceId: string) => {
    const ids = [invoiceId, ...(await prisma.invoicePayment.findMany({ where: { invoiceId }, select: { id: true } })).map((p) => p.id)];
    return (await prisma.auditLog.findMany({ where: { companyId: t.company.id, recordId: { in: ids }, action: { in: ['REVERSE', 'VOID', 'DELETE'] } } })).map((a) => a.action).sort();
  };

  // A tenant whose invoices carry a seller GST registration (so a filed GST period can protect them).
  async function gstTenantWith(tag: string) {
    const x = await tenantWith(tag, ['invoice:delete']);
    const reg = await createGstRegistration(x.t.ctx, { gstin: '24AAAAA0000A1Z5', legalName: `Del Co ${tag}${suffix}`, stateCode: '24', isPrimary: true, isActive: true });
    regs.push({ id: reg.id, companyId: x.t.company.id });
    return { ...x, regId: reg.id };
  }

  it('a bill in a FILED GSTR-1 period is refused before anything is reversed (nothing changes)', async () => {
    const { t, api, regId } = await gstTenantWith('G1');
    const bill = await makeBill(t, { paid: true });
    const before = await stateOf(t, bill);
    expect(before.payments).toEqual([[expect.any(String), 'live']]);

    const period = await tenantQuery(t.company.id, (tx) => tx.gstReturnPeriod.create({ data: { companyId: t.company.id, gstRegistrationId: regId, returnType: 'GSTR1', financialYear: '2031-32', taxPeriod: `01${suffix}` } }));
    const now = new Date();
    const snap = await tenantQuery(t.company.id, (tx) => tx.gstFilingSnapshot.create({ data: {
      companyId: t.company.id, returnPeriodId: period.id, version: 1, canonicalDtoJson: { traceability: { b2bInvoiceIds: [bill.invoiceId], b2clInvoiceIds: [] } }, wireJson: { stub: true },
      canonicalDtoHash: 'h', wireJsonHash: 'h', serializerVersion: 'v0', adapterVersion: 'v0', periodFrom: now, periodTo: now,
      branchScope: { scope: 'REGISTRATION' }, validationResult: { blockers: [], warnings: [] }, sourceDataCutoff: now, reportParams: { gstRegistrationId: 'stub' }, status: 'DRAFT',
    } as any }));
    const attempt = await tenantQuery(t.company.id, (tx) => tx.gstFilingAttempt.create({ data: {
      companyId: t.company.id, returnPeriodId: period.id, snapshotId: snap.id, attemptNumber: 1, mode: 'MANUAL_EXPORT', payloadHash: 'h', status: 'ACCEPTED', filedAt: now,
    } as any }));
    await tenantQuery(t.company.id, (tx) => tx.gstReturnPeriod.update({ where: { id: period.id }, data: { status: 'FILED', filedAt: now, filedSnapshotId: snap.id, filedByAttemptId: attempt.id, filedById: t.user.id } }));

    const res = await api.post(`/sales/invoices/${bill.invoiceId}/delete`, { reason: 'try to delete a filed bill' });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatch(/GSTR-1/);
    expect(res.body.error).toMatch(/Nothing was changed/);
    expect(await stateOf(t, bill)).toEqual(before); // receipt still live, invoice PAID, tag SOLD, balance and journal untouched
  });

  it('a bill in a FILED GSTR-3B period is refused before anything is reversed (nothing changes)', async () => {
    const { t, api, regId } = await gstTenantWith('G3');
    const bill = await makeBill(t, { paid: true });
    const before = await stateOf(t, bill);
    const now = new Date();
    await tenantQuery(t.company.id, (tx) => tx.gstReturnPeriod.create({ data: {
      companyId: t.company.id, gstRegistrationId: regId, returnType: 'GSTR3B', financialYear: getFinancialYearForDate(now), taxPeriod: resolveFilingPeriodMmYYYY(now), status: 'FILED',
    } }));

    const res = await api.post(`/sales/invoices/${bill.invoiceId}/delete`, { reason: 'try to delete a filed bill' });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatch(/GSTR3B_FILED_PERIOD_IMMUTABLE|GSTR-3B/i);
    expect(await stateOf(t, bill)).toEqual(before);
  });

  it('a tag that is no longer SOLD refuses the delete without reversing the receipt; once fixed, a retry succeeds and reverses it exactly once', async () => {
    const { t, api } = await tenantWith('TG', ['invoice:delete']);
    const bill = await makeBill(t, { paid: true });
    await prisma.jewelryTag.update({ where: { id: bill.tagId }, data: { status: 'IN_STOCK' } });
    const before = await stateOf(t, bill);

    const res = await api.post(`/sales/invoices/${bill.invoiceId}/delete`, { reason: 'first try' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not currently SOLD/);
    expect(await stateOf(t, bill)).toEqual(before);

    await prisma.jewelryTag.update({ where: { id: bill.tagId }, data: { status: 'SOLD' } });
    const retry = await api.post(`/sales/invoices/${bill.invoiceId}/delete`, { reason: 'second try' });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.data.reversedPayments).toBe(1);
    const after = await stateOf(t, bill);
    expect(after).toMatchObject({ status: 'VOID', tag: 'IN_STOCK', clientBalance: 0 });
    expect(after.payments).toEqual([[expect.any(String), 'reversed']]);
    // exactly one REVERSE, one VOID, one DELETE audit - the refused first attempt left none behind
    expect(await reversalAudits(t, bill.invoiceId)).toEqual(['DELETE', 'REVERSE', 'VOID']);
  });

  it('a failure AFTER the first receipt was reversed rolls the whole delete back (receipt, ledger, balance, audit)', async () => {
    const { t, api } = await tenantWith('RB', ['invoice:delete']);
    const bill = await makeBill(t, { paid: true });
    // A second receipt that cannot be reversed: an old-gold payment whose exchange does not exist. It is processed AFTER the
    // cash receipt (later paymentDate), so the cash reversal has already run inside the transaction when this one throws.
    const later = new Date(Date.now() + 24 * 3600 * 1000);
    await prisma.invoicePayment.create({ data: {
      companyId: t.company.id, paymentNumber: `PMT-RB-${suffix}`, clientId: bill.clientId, invoiceId: bill.invoiceId,
      paymentDate: later, amount: 1, mode: 'OLD_GOLD', referenceNo: `NO-SUCH-EXCHANGE-${suffix}`,
    } as any });
    const before = await stateOf(t, bill);
    expect(before.payments.filter(([, st]) => st === 'live')).toHaveLength(2);

    const res = await api.post(`/sales/invoices/${bill.invoiceId}/delete`, { reason: 'will fail mid-way' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatch(/old-gold exchange/i);
    // the cash receipt that WAS reversed inside the failed transaction is live again; nothing persisted
    expect(await stateOf(t, bill)).toEqual(before);
  });

  it('three simultaneous deletes: exactly one succeeds, the rest are controlled conflicts, and nothing is applied twice', async () => {
    const { t, api } = await tenantWith('CC', ['invoice:delete']);
    const bill = await makeBill(t, { paid: true });
    const results = await Promise.all([1, 2, 3].map((k) => api.post(`/sales/invoices/${bill.invoiceId}/delete`, { reason: `parallel delete ${k}` })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses, JSON.stringify(results.map((r) => r.body))).toEqual([200, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.error).toMatch(/already been voided|already been reversed/);

    const after = await stateOf(t, bill);
    expect(after).toMatchObject({ status: 'VOID', tag: 'IN_STOCK', clientBalance: 0 });
    expect(after.payments).toEqual([[expect.any(String), 'reversed']]);
    const pay = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: bill.invoiceId } });
    // one reversal journal per receipt, one void journal, and one of each audit row
    const entries = await prisma.journalEntry.findMany({ where: { companyId: t.company.id, referenceId: { in: [bill.invoiceId, pay.id] } } });
    expect(entries.filter((e) => e.referenceType === 'InvoicePaymentReversal')).toHaveLength(1);
    expect(entries.filter((e) => e.referenceType === 'SalesInvoiceVoid')).toHaveLength(1);
    expect(await reversalAudits(t, bill.invoiceId)).toEqual(['DELETE', 'REVERSE', 'VOID']);
  });

  it('a payment racing a delete never lands on the voided bill: either it is rejected, or the delete reverses it too', async () => {
    const { t, api } = await tenantWith('RC', ['invoice:delete']);
    const bill = await makeBill(t); // unpaid, 103 due
    const [del, pay] = await Promise.allSettled([
      api.post(`/sales/invoices/${bill.invoiceId}/delete`, { reason: 'race with a payment' }),
      recordPayment({ invoiceId: bill.invoiceId, mode: 'CASH', amount: 50, paymentDate: new Date() } as any, t.ctx, t.user.id),
    ]);
    expect(del.status).toBe('fulfilled');
    expect((del as PromiseFulfilledResult<any>).value.status, JSON.stringify((del as any).value?.body)).toBe(200);
    const inv = await invoiceOf(bill.invoiceId);
    expect(inv.status).toBe('VOID'); // never overwritten back to PARTIALLY_PAID by the racing payment
    const pays = await prisma.invoicePayment.findMany({ where: { invoiceId: bill.invoiceId } });
    expect(pays.filter((p) => !p.reversedAt)).toHaveLength(0); // no live receipt hangs off a voided bill
    if (pay.status === 'rejected') expect(pays).toHaveLength(0);
    expect(await balanceOf(bill.clientId)).toBeCloseTo(0, 2);
    expect(await tagStatus(bill.tagId)).toBe('IN_STOCK');
  });

  it('invoice:delete is in the permission catalog (so the Role Editor can assign it) and is not given to any starter role', async () => {
    const found: string[] = [];
    const walk = (o: any) => { if (o && typeof o === 'object') { if (o.permission === 'invoice:delete' || o.key === 'invoice:delete') found.push(JSON.stringify(o)); Object.values(o).forEach(walk); } };
    walk(PERMISSION_CATALOG);
    expect(found.length).toBeGreaterThan(0);
    const { STARTER_PACKAGE_V1 } = await import('../modules/platform/starterPackage/v1');
    expect(JSON.stringify(STARTER_PACKAGE_V1)).not.toContain('invoice:delete'); // delegated by the company's Super Admin, never pre-granted
  });
});
