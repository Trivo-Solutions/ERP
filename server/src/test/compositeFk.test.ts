import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database';
import { provisionCompany } from '../modules/platform/provisioning.service';
import { purgeCompany, uniqueCompanyCode, crossCompanyForeignKeyViolations } from './fixtures';

// ═══════════════════════════════════════════════════════════════════════════
// Phase 5 — composite foreign keys. RLS does not make a foreign key tenant-safe (FK checks bypass it), so the
// high-risk relations are COMPOSITE keys ("fk","companyId") -> parent("id","companyId"): the DATABASE refuses a
// child that points at a parent owned by a different company. These tests write with the platform role
// (BYPASSRLS) on purpose — the FK constraint must hold even for a caller that bypasses every policy.
// ═══════════════════════════════════════════════════════════════════════════

const DOMAIN = '@compfk.example.com';

describe('Phase 5: composite foreign keys refuse cross-company references at the database', () => {
  const created: string[] = [];
  const A: Record<string, string> = {}; const B: Record<string, string> = {};
  let sfx = 0;
  const u = (p: string) => `${p}${Date.now().toString(36)}${sfx++}`;

  async function bringUp(into: Record<string, string>, tag: string) {
    const code = uniqueCompanyCode(tag);
    const r = await provisionCompany({ code, name: `Composite ${tag}`, admin: { email: `${code.toLowerCase()}${DOMAIN}`, name: 'Owner Person', password: 'CompFk-Passw0rd-123' } });
    created.push(r.company.id);
    const id = r.company.id;
    into.company = id; into.branch = r.branch.id; into.userId = (r.admin as any).userId;
    into.category = (await prisma.productCategory.findFirstOrThrow({ where: { companyId: id, code: 'RNG' } })).id;
    into.sub = (await prisma.subCategory.findFirstOrThrow({ where: { companyId: id } })).id;
    into.stockType = (await prisma.stockType.findFirstOrThrow({ where: { companyId: id, code: 'R' } })).id;
    into.stoneType = (await prisma.stoneType.findFirstOrThrow({ where: { companyId: id, code: 'DIA' } })).id;
    into.stoneGrade = (await prisma.stoneGrade.findFirstOrThrow({ where: { companyId: id } })).id;
    into.role = (await prisma.role.findFirstOrThrow({ where: { companyId: id, name: 'SUPER_ADMIN' } })).id;
    into.client = (await prisma.client.create({ data: { companyId: id, clientCode: u('C'), name: 'Client', type: 'RETAIL' } })).id;
    into.supplier = (await prisma.supplier.create({ data: { companyId: id, supplierCode: u('S'), name: 'Supplier', type: 'OTHER' } })).id;
    into.tag = (await prisma.jewelryTag.create({ data: { companyId: id, tagNumber: u('T'), branchId: r.branch.id, name: 'Tag', metalType: 'GOLD', grossWeight: 1, netWeight: 1, createdById: into.userId, categoryId: into.category, stockTypeId: into.stockType } })).id;
  }

  beforeAll(async () => { await bringUp(A, 'CFA'); await bringUp(B, 'CFB'); }, 120_000);
  afterAll(async () => {
    const members = await prisma.companyUser.findMany({ where: { user: { email: { endsWith: DOMAIN } } }, select: { companyId: true } });
    for (const id of new Set([...created, ...members.map((m) => m.companyId)])) await purgeCompany(id);
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await prisma.$disconnect();
  });

  const FK = /foreign key/i;

  // each forgery: a row OWNED BY B that points at a parent owned by A
  const forgeries: Array<[string, () => Promise<unknown>]> = [
    ['tag -> another company\'s category', () => prisma.jewelryTag.create({ data: { companyId: B.company, tagNumber: u('F'), branchId: B.branch, name: 'x', metalType: 'GOLD', grossWeight: 1, netWeight: 1, createdById: B.userId, categoryId: A.category } })],
    ['tag -> another company\'s stock type', () => prisma.jewelryTag.create({ data: { companyId: B.company, tagNumber: u('F'), branchId: B.branch, name: 'x', metalType: 'GOLD', grossWeight: 1, netWeight: 1, createdById: B.userId, stockTypeId: A.stockType } })],
    ['tag -> another company\'s branch', () => prisma.jewelryTag.create({ data: { companyId: B.company, tagNumber: u('F'), branchId: A.branch, name: 'x', metalType: 'GOLD', grossWeight: 1, netWeight: 1, createdById: B.userId } })],
    ['tag -> another company\'s manufacturer (client)', () => prisma.jewelryTag.create({ data: { companyId: B.company, tagNumber: u('F'), branchId: B.branch, name: 'x', metalType: 'GOLD', grossWeight: 1, netWeight: 1, createdById: B.userId, manufacturerId: A.client } })],
    ['invoice -> another company\'s client', () => prisma.salesInvoice.create({ data: { companyId: B.company, branchId: B.branch, invoiceNumber: u('I'), clientId: A.client, invoiceDate: new Date(), invoiceType: 'RETAIL', subtotal: 1, totalAmount: 1, balanceDue: 1 } })],
    ['invoice -> another company\'s branch', () => prisma.salesInvoice.create({ data: { companyId: B.company, branchId: A.branch, invoiceNumber: u('I'), clientId: B.client, invoiceDate: new Date(), invoiceType: 'RETAIL', subtotal: 1, totalAmount: 1, balanceDue: 1 } })],
    ['memo -> another company\'s client', () => prisma.memoOut.create({ data: { companyId: B.company, memoNumber: u('M'), clientId: A.client, branchId: B.branch, sentDate: new Date(), returnDeadline: new Date(), totalValue: 1 } })],
    ['member -> another company\'s ROLE (privilege confusion)', async () => {
      const usr = await prisma.user.create({ data: { email: `${u('m')}${DOMAIN}`, name: 'Member', password: 'x' } });
      return prisma.companyUser.create({ data: { companyId: B.company, userId: usr.id, roleId: A.role } });
    }],
    ['invitation -> another company\'s role', () => prisma.companyInvitation.create({ data: { companyId: B.company, email: `${u('i')}${DOMAIN}`, roleId: A.role, tokenHash: u('h'), expiresAt: new Date(Date.now() + 1e6) } })],
    ['making charge -> another company\'s category', () => prisma.makingCharge.create({ data: { companyId: B.company, categoryId: A.category } })],
    ['price master -> another company\'s stone grade', () => prisma.priceMaster.create({ data: { companyId: B.company, itemType: 'DIAMOND', pricePerCarat: 1, stoneGradeId: A.stoneGrade } })],
    ['sub-category link -> another company\'s category', () => prisma.categorySubCategory.create({ data: { companyId: B.company, categoryId: A.category, subCategoryId: B.sub } })],
    ['sub-category link -> another company\'s sub-category', () => prisma.categorySubCategory.create({ data: { companyId: B.company, categoryId: B.category, subCategoryId: A.sub } })],
    ['stone grade -> another company\'s stone type', () => prisma.stoneGrade.create({ data: { companyId: B.company, stoneTypeId: A.stoneType } })],
    ['purchase order -> another company\'s supplier', () => prisma.purchaseOrder.create({ data: { companyId: B.company, poNumber: u('P'), supplierId: A.supplier, poType: 'METAL', orderDate: new Date(), subtotal: 1, totalAmount: 1 } })],
    ['UPDATE: re-point B\'s own tag at A\'s category', () => prisma.jewelryTag.update({ where: { id: B.tag }, data: { categoryId: A.category } })],
    ['UPDATE: re-point B\'s own tag at A\'s branch', () => prisma.jewelryTag.update({ where: { id: B.tag }, data: { branchId: A.branch } })],
  ];

  it.each(forgeries)('REJECTED: %s', async (_name, attempt) => {
    await expect(attempt()).rejects.toThrow(FK);
  });

  it('control: the SAME writes pointing at the company\'s OWN parents succeed (the keys do not block legitimate use)', async () => {
    await expect(prisma.jewelryTag.create({ data: { companyId: B.company, tagNumber: u('OK'), branchId: B.branch, name: 'ok', metalType: 'GOLD', grossWeight: 1, netWeight: 1, createdById: B.userId, categoryId: B.category, stockTypeId: B.stockType } })).resolves.toBeTruthy();
    await expect(prisma.salesInvoice.create({ data: { companyId: B.company, branchId: B.branch, invoiceNumber: u('OK'), clientId: B.client, invoiceDate: new Date(), invoiceType: 'RETAIL', subtotal: 1, totalAmount: 1, balanceDue: 1 } })).resolves.toBeTruthy();
    const okSub = await prisma.subCategory.create({ data: { companyId: B.company, code: u('OK'), name: 'ok' } });
    await expect(prisma.categorySubCategory.create({ data: { companyId: B.company, categoryId: B.category, subCategoryId: okSub.id } })).resolves.toBeTruthy();
    await expect(prisma.purchaseOrder.create({ data: { companyId: B.company, poNumber: u('OK'), supplierId: B.supplier, poType: 'METAL', orderDate: new Date(), subtotal: 1, totalAmount: 1 } })).resolves.toBeTruthy();
    await expect(prisma.jewelryTag.update({ where: { id: B.tag }, data: { categoryId: B.category } })).resolves.toBeTruthy();
  });

  it('optional references may still be left empty (NULL is not a cross-company reference)', async () => {
    await expect(prisma.jewelryTag.create({ data: { companyId: B.company, tagNumber: u('NULL'), branchId: B.branch, name: 'no category', metalType: 'GOLD', grossWeight: 1, netWeight: 1, createdById: B.userId } })).resolves.toBeTruthy();
  });

  it('a master still referenced by a tag cannot be deleted from under it (composite keys use RESTRICT)', async () => {
    await expect(prisma.productCategory.delete({ where: { id: B.category } })).rejects.toThrow(/foreign key|violates/i);
  });

  it('the catalog holds the composite keys: 58+ foreign keys whose column list includes companyId', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`
      SELECT count(*)::int n FROM pg_constraint con
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey) AND a.attname = 'companyId'
      WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 2`);
    expect(rows[0].n).toBeGreaterThanOrEqual(58);
  });

  it('after all of that, ZERO cross-company references exist anywhere in the database', async () => {
    expect(await crossCompanyForeignKeyViolations()).toEqual([]);
  });
});
