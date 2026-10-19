import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, tokenFor, apiWith, purgeCompany, TestTenant } from './fixtures';

// Sales-employee attribution on a saved bill, over real HTTP: the employee chosen when billing is what the saved bill shows
// when reopened; picking one never changes the money or the stock; a bill with none stays valid; and deactivating an
// employee removes them from the billing list without rewriting history.
describe('HTTP: bill sales-employee attribution', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const emails: string[] = [];
  const companies: string[] = [];
  let seq = 0;

  afterAll(async () => {
    for (const id of companies) await purgeCompany(id);
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await prisma.$disconnect();
  });

  async function setup(tag: string) {
    const t: TestTenant = await createTestTenant(`${tag}${suffix}`, ['user:manage', 'invoice:create', 'sales:view']);
    companies.push(t.company.id);
    emails.push(t.user.email);
    const staffRole = await prisma.role.create({ data: { companyId: t.company.id, name: `STAFF_${tag}${suffix}`, displayName: 'Staff', permissions: ['invoice:create'] } });
    const client = await prisma.client.create({ data: { companyId: t.company.id, clientCode: `CL-${tag}${suffix}`, name: 'Walk-in Buyer', type: 'RETAIL', panNumber: 'ABCDE1234F' } });
    const api = apiWith(tokenFor(t), app);
    const makeEmployee = async (name: string) => {
      const email = `att-${seq++}-${suffix}@example.com`;
      emails.push(email);
      const r = await api.post('/sales-employees', { name, email, roleId: staffRole.id, employeeId: `A${seq}`, branchIds: [t.branch.id] });
      expect(r.status).toBe(201);
      return r.body.data.employee as { id: string; userId: string };
    };
    const makeTag = (n: number) => prisma.jewelryTag.create({
      data: {
        tagNumber: `ATT-${tag}${suffix}-${n}`, companyId: t.company.id, branchId: t.branch.id, name: `Ring ${n}`, metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 5, netWeight: 5, stoneWeight: 0, costPrice: 20000, sellingPrice: 30000, createdById: t.user.id,
      },
    });
    const bill = (tagId: string, extra: object = {}) => api.post('/sales/invoices', {
      clientId: client.id, branchId: t.branch.id, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
      items: [{ tagId, productCode: 'RING', description: 'Gold ring', quantity: 1, grossWeight: 5, netGoldWeight: 5, rateType: 'FIXED', goldRate: 30000, makingCharge: 0 }],
      payments: [{ mode: 'UPI', amount: 10000, paymentDate: new Date().toISOString() }],
      ...extra,
    });
    return { t, api, makeEmployee, makeTag, bill };
  }

  it('saves the chosen employee with the bill and shows the same employee when it is reopened or listed', async () => {
    const { api, makeEmployee, makeTag, bill } = await setup('A');
    const emp = await makeEmployee('Asha Rao');
    const tag = await makeTag(1);
    const created = await bill(tag.id, { salesPersonId: emp.userId });
    expect(created.status).toBe(201);
    expect(created.body.data.salesPersonId).toBe(emp.userId);

    const reopened = await api.get(`/sales/invoices/${created.body.data.id}`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.salesPerson).toEqual({ id: emp.userId, name: 'Asha Rao' });
    const listed = (await api.get('/sales/invoices?limit=50')).body;
    const row = (listed.data?.invoices ?? listed.data ?? []).find((i: any) => i.id === created.body.data.id);
    expect(row?.salesPerson?.name).toBe('Asha Rao');
  });

  it('choosing an employee changes nothing but the attribution: same prices, tax, payments and stock movement', async () => {
    const { t, makeEmployee, makeTag, bill } = await setup('P');
    const emp = await makeEmployee('Ravi Kumar');
    const [t1, t2] = [await makeTag(1), await makeTag(2)];
    const withEmp = (await bill(t1.id, { salesPersonId: emp.userId })).body.data;
    const without = (await bill(t2.id)).body.data;
    for (const k of ['subtotal', 'taxAmount', 'totalAmount', 'paidAmount', 'balanceDue', 'status', 'discountAmount', 'currency']) {
      expect(String(withEmp[k]), k).toBe(String(without[k]));
    }
    expect(withEmp.items.map((i: any) => [String(i.unitPrice), String(i.taxRate)])).toEqual(without.items.map((i: any) => [String(i.unitPrice), String(i.taxRate)]));
    // Stock: both pieces left the shelf the same way, regardless of who got the credit.
    const tags = await prisma.jewelryTag.findMany({ where: { id: { in: [t1.id, t2.id] } }, select: { status: true } });
    expect(tags.map((x) => x.status)).toEqual(['SOLD', 'SOLD']);
    // Independent of the cashier and of the branch: the cashier is the logged-in user, not the employee.
    expect(withEmp.salesPersonId).toBe(emp.userId);
    expect(withEmp.salesPersonId).not.toBe(t.user.id);
    // The ledger booked the same amounts either way.
    const journals = await prisma.journalEntry.findMany({ where: { companyId: t.company.id, referenceId: { in: [withEmp.id, without.id] } }, include: { lines: true } });
    const totals = journals.map((j) => j.lines.reduce((s, l) => s + Number(l.debit), 0).toFixed(2)).sort();
    expect(totals).toHaveLength(2);
    expect(totals[0]).toBe(totals[1]);
  });

  it('a bill with no employee stays valid, reopens, lists and shows no attribution', async () => {
    const { api, makeTag, bill } = await setup('N');
    const created = await bill((await makeTag(1)).id);
    expect(created.status).toBe(201);
    expect(created.body.data.salesPersonId).toBeNull();
    const reopened = await api.get(`/sales/invoices/${created.body.data.id}`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.salesPerson).toBeNull();
    const listed = (await api.get('/sales/invoices?limit=50')).body;
    const row = (listed.data?.invoices ?? listed.data ?? []).find((i: any) => i.id === created.body.data.id);
    expect(row).toBeTruthy();
    expect(row.salesPerson ?? null).toBeNull();
  });

  it('a deactivated employee leaves the billing list and cannot be chosen, while old bills keep them; reactivating restores them', async () => {
    const { api, makeEmployee, makeTag, bill } = await setup('D');
    const emp = await makeEmployee('Meena Iyer');
    const old = (await bill((await makeTag(1)).id, { salesPersonId: emp.userId })).body.data;
    const staffIds = async () => (await api.get('/sales/staff')).body.data.map((s: any) => s.id);
    expect(await staffIds()).toContain(emp.userId);

    expect((await api.patch(`/sales-employees/${emp.id}`, { isActive: false })).status).toBe(200);
    expect(await staffIds()).not.toContain(emp.userId);
    const refused = await bill((await makeTag(2)).id, { salesPersonId: emp.userId });
    expect(refused.status).toBe(404); // refused before anything is saved
    expect(await prisma.jewelryTag.count({ where: { name: 'Ring 2', status: 'SOLD', companyId: old.companyId } })).toBe(0);

    // History is not rewritten.
    const reopened = await api.get(`/sales/invoices/${old.id}`);
    expect(reopened.body.data.salesPerson).toEqual({ id: emp.userId, name: 'Meena Iyer' });

    expect((await api.patch(`/sales-employees/${emp.id}`, { isActive: true })).status).toBe(200);
    expect(await staffIds()).toContain(emp.userId);
  });

  it('refuses an employee from another company on a bill (nothing saved, stock untouched)', async () => {
    const a = await setup('X1');
    const b = await setup('X2');
    const foreign = await b.makeEmployee('Other Company Person');
    const tag = await a.makeTag(1);
    const res = await a.bill(tag.id, { salesPersonId: foreign.userId });
    expect(res.status).toBe(404);
    expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('IN_STOCK');
  });
});
