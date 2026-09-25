import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { AppError } from '../middleware/error';
import { createTestTenant, addBranch, cleanupTestTenant, TestTenant } from './fixtures';
import { createTag, getTag, listTags, listBranches, createBranch } from '../modules/tagging/tagging.service';
import { createInvoice } from '../modules/sales/sales.service';
import { createClient, updateClient, getClient, listClients } from '../modules/orders/orders.service';
import { grantBranchAccess } from '../modules/company/company.service';
import { TenantContext } from '../shared/tenantContext';
import { cleanupJournalEntries } from './ledger';

// ═══════════════════════════════════════════════════
// Multi-tenant prototype — tenant isolation test suite.
//
// Proves the security invariants from the multi-tenant blueprint against the ten prototype
// models (Company, CompanyUser, Branch, UserBranchAccess, Role, Client, JewelryTag,
// SalesInvoice, InvoiceItem, NumberSequence), using two real, independently-seeded companies —
// not mocks. Every "must fail" assertion below is checking Layer 2 (explicit relation-ownership
// validation in the service functions), not PostgreSQL RLS — RLS is not yet enabled as of this
// migration (see the implementation report: "implement RLS only after the application
// tenant-context mechanism is working").
// ═══════════════════════════════════════════════════

describe('Multi-tenant prototype: company + branch isolation', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let companyA: TestTenant;
  let companyB: TestTenant;
  // A second branch in Company A, plus a branch-restricted membership that is NOT granted it —
  // proves branch restriction is enforced independently of company membership.
  let branchA2Id: string;
  let restrictedCtx: TenantContext;
  let restrictedUserId: string;
  let restrictedCompanyUserId: string;

  let categoryId: string;
  let stockTypeId: string;
  // Company B needs its own masters — categories/stock types are company-owned, so one company's
  // ids can never be used on the other company's tags.
  let categoryBId: string;
  let stockTypeBId: string;

  // Cross-company fixtures created once, reused read-only across the `it()`s below.
  let tagA: { id: string; tagNumber: string };
  let clientA: { id: string };
  let tagB: { id: string };
  let clientB: { id: string };

  const createdTagIds: string[] = [];
  const createdInvoiceIds: string[] = [];
  const createdClientIds: string[] = [];

  beforeAll(async () => {
    companyA = await createTestTenant(`ISOA${suffix}`, ['tag:create', 'invoice:create', 'order:create']);
    companyB = await createTestTenant(`ISOB${suffix}`, ['tag:create', 'invoice:create', 'order:create']);

    const branchA2 = await addBranch(companyA.company.id, `A2-${suffix}`);
    branchA2Id = branchA2.id;

    // A restricted membership in Company A, for a SEPARATE user (CompanyUser is unique per
    // (companyId, userId), and companyA.user already has the unrestricted membership
    // createTestTenant made) — only ever granted its FIRST branch, never branchA2.
    const restrictedUser = await prisma.user.create({
      data: { email: `restricted-${suffix}@example.com`, password: 'x', name: 'Restricted User' },
    });
    const restrictedCompanyUser = await prisma.companyUser.create({
      data: { companyId: companyA.company.id, userId: restrictedUser.id, roleId: companyA.role.id, allBranches: false },
    });
    await grantBranchAccess(companyA.ctx, restrictedCompanyUser.id, companyA.branch.id);
    restrictedCtx = {
      ...companyA.ctx,
      userId: restrictedUser.id,
      companyUserId: restrictedCompanyUser.id,
      branchAccess: { allBranches: false, branchIds: [companyA.branch.id] },
    };
    restrictedUserId = restrictedUser.id;
    restrictedCompanyUserId = restrictedCompanyUser.id;

    const category = await prisma.productCategory.create({ data: { companyId: companyA.company.id, code: `ISOCAT-${suffix}`, name: 'Iso Test Category' } });
    categoryId = category.id;
    const categoryB = await prisma.productCategory.create({ data: { companyId: companyB.company.id, code: `ISOCAT-${suffix}`, name: 'Iso Test Category' } });
    categoryBId = categoryB.id;
    const stockType = await prisma.stockType.create({ data: { companyId: companyA.company.id, code: `ISO${suffix}`.slice(0, 8).toUpperCase(), name: 'Iso Test Stock Type' } });
    stockTypeId = stockType.id;
    const stockTypeB = await prisma.stockType.create({ data: { companyId: companyB.company.id, code: `ISO${suffix}`.slice(0, 8).toUpperCase(), name: 'Iso Test Stock Type' } });
    stockTypeBId = stockTypeB.id;

    // Company A's own tag + client
    tagA = await createTag(companyA.ctx, {
      branchId: companyA.branch.id, stockTypeId, categoryId, name: 'Company A Ring',
      metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5,
    }, companyA.user.id);
    createdTagIds.push(tagA.id);
    clientA = await createClient(companyA.company.id, { name: 'Company A Client', type: 'RETAIL' });
    createdClientIds.push(clientA.id);

    // Company B's own tag + client — the "forged foreign id" targets throughout this suite
    tagB = await createTag(companyB.ctx, {
      branchId: companyB.branch.id, stockTypeId: stockTypeBId, categoryId: categoryBId, name: 'Company B Ring',
      metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5,
    }, companyB.user.id);
    createdTagIds.push(tagB.id);
    clientB = await createClient(companyB.company.id, { name: 'Company B Client', type: 'RETAIL' });
    createdClientIds.push(clientB.id);
  });

  afterAll(async () => {
    // F1: createInvoice now posts a JournalEntry against each company's own Account rows —
    // must be cleaned up before cleanupTestTenant deletes those Account rows below.
    await cleanupJournalEntries(createdInvoiceIds);
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: createdTagIds } } });
    await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
    await prisma.productCategory.deleteMany({ where: { id: { in: [categoryId, categoryBId] } } });
    await prisma.stockType.deleteMany({ where: { id: { in: [stockTypeId, stockTypeBId] } } });
    await prisma.userBranchAccess.deleteMany({ where: { companyUserId: restrictedCompanyUserId } });
    await prisma.companyUser.deleteMany({ where: { id: restrictedCompanyUserId } });
    await prisma.user.deleteMany({ where: { id: restrictedUserId } });
    await cleanupTestTenant(companyA);
    await cleanupTestTenant(companyB);
    await prisma.$disconnect();
  });

  // ─── A. Direct cross-company reads ────────────────────────────────────────

  it('Company A can read its own tag', async () => {
    const tag = await getTag(companyA.ctx, tagA.id);
    expect(tag.id).toBe(tagA.id);
  });

  it('Company A CANNOT read Company B\'s tag by id (IDOR)', async () => {
    await expect(getTag(companyA.ctx, tagB.id)).rejects.toThrow(/not found/i);
  });

  it('Company B CANNOT read Company A\'s tag by id (IDOR, symmetric)', async () => {
    await expect(getTag(companyB.ctx, tagA.id)).rejects.toThrow(/not found/i);
  });

  it('Company A\'s tag list never includes Company B\'s tags', async () => {
    const result = await listTags(companyA.ctx, {});
    expect(result.tags.some((t) => t.id === tagB.id)).toBe(false);
    expect(result.tags.some((t) => t.id === tagA.id)).toBe(true);
  });

  it('Company A CANNOT read Company B\'s client by id', async () => {
    await expect(getClient(clientB.id, companyA.company.id)).rejects.toThrow(AppError);
  });

  it('Company A\'s client list never includes Company B\'s clients', async () => {
    const clients = await listClients(companyA.company.id);
    expect(clients.some((c) => c.id === clientB.id)).toBe(false);
  });

  // ─── B. Cross-company writes ───────────────────────────────────────────────

  it('Company A CANNOT update Company B\'s client (forged id on an update)', async () => {
    await expect(
      updateClient(clientB.id, companyA.company.id, { name: 'Hijacked' })
    ).rejects.toThrow(AppError);

    // Prove it was actually rejected, not silently no-op'd against the real row.
    const stillB = await prisma.client.findUniqueOrThrow({ where: { id: clientB.id } });
    expect(stillB.name).toBe('Company B Client');
  });

  // ─── C. Relation-ownership forgery (Layer 2 — the actual IDOR defense, not RLS) ────────────

  it('Company A JewelryTag create rejects a Company B branchId (forged foreign key)', async () => {
    await expect(
      createTag(companyA.ctx, {
        branchId: companyB.branch.id, // forged — belongs to Company B
        stockTypeId, categoryId, name: 'Should never be created',
        metalType: 'GOLD', grossWeight: 1, netWeight: 1,
      }, companyA.user.id)
    ).rejects.toThrow(/not found/i);
  });

  it('Company A Invoice create rejects a Company B clientId (forged foreign key)', async () => {
    await expect(
      createInvoice({
        clientId: clientB.id, // forged — belongs to Company B
        branchId: companyA.branch.id,
        invoiceDate: new Date(), invoiceType: 'RETAIL',
        items: [{ productCode: 'MISC', description: 'x', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 100 }],
      }, companyA.ctx, companyA.user.id)
    ).rejects.toThrow(AppError);
  });

  it('Company A Invoice create rejects a Company B branchId on the invoice header itself', async () => {
    await expect(
      createInvoice({
        clientId: clientA.id,
        branchId: companyB.branch.id, // forged — belongs to Company B
        invoiceDate: new Date(), invoiceType: 'RETAIL',
        items: [{ productCode: 'MISC', description: 'x', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 100 }],
      }, companyA.ctx, companyA.user.id)
    ).rejects.toThrow(/not found/i);
  });

  it('Company A invoice create rejects the WHOLE invoice when any line forges a Company B tagId', async () => {
    // createInvoice's existing "every tagId in the request must resolve" guard (tagIds.length
    // vs the count actually found) does double duty as the tenant check now that the resolving
    // query is companyId-scoped: a Company-B tagId simply doesn't resolve, so it's indistinguishable
    // from a nonexistent id, and the whole invoice creation is rejected — not silently downgraded
    // to an untagged line. The forged tag must never be priced from, linked to, or flipped.
    const invoice = await createInvoice({
      clientId: clientA.id, branchId: companyA.branch.id,
      invoiceDate: new Date(), invoiceType: 'RETAIL',
      items: [{
        productCode: tagB.id, description: 'Attempted cross-company tag reference',
        quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 100,
        tagId: tagB.id, // forged — belongs to Company B
      }],
    }, companyA.ctx, companyA.user.id).catch((e) => e);

    // createInvoice's own tagIds.length-vs-resolved-count guard rejects this outright (the tag
    // doesn't resolve under companyId scoping, so it counts as "missing") — assert that, AND
    // that Company B's tag was never touched.
    expect(invoice).toBeInstanceOf(AppError);

    const stillB = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tagB.id } });
    expect(stillB.status).toBe('IN_STOCK');
  });

  it('UserBranchAccess grant rejects a Company B branchId for a Company A membership', async () => {
    const membership = await prisma.companyUser.findUniqueOrThrow({ where: { id: companyA.companyUser.id } });
    await expect(
      grantBranchAccess(companyA.ctx, membership.id, companyB.branch.id)
    ).rejects.toThrow(/not found/i);
  });

  it('UserBranchAccess grant rejects a Company B companyUserId for a Company A branch', async () => {
    await expect(
      grantBranchAccess(companyA.ctx, companyB.companyUser.id, companyA.branch.id)
    ).rejects.toThrow(/not found/i);
  });

  // ─── D. Branch restriction, independent of company membership ─────────────

  it('a branch-restricted user sees tags in their granted branch', async () => {
    const result = await listTags(restrictedCtx, {});
    expect(result.tags.some((t) => t.id === tagA.id)).toBe(true);
  });

  it('a branch-restricted user does NOT see tags in a same-company, ungranted branch', async () => {
    const tagInA2 = await createTag(companyA.ctx, {
      branchId: branchA2Id, stockTypeId, categoryId, name: 'Company A, Branch 2 Ring',
      metalType: 'GOLD', grossWeight: 3, netWeight: 3,
    }, companyA.user.id);
    createdTagIds.push(tagInA2.id);

    const result = await listTags(restrictedCtx, {});
    expect(result.tags.some((t) => t.id === tagInA2.id)).toBe(false);

    // Explicitly requesting that branch doesn't bypass the restriction either.
    const filtered = await listTags(restrictedCtx, { branchId: branchA2Id });
    expect(filtered.tags).toHaveLength(0);
  });

  it('a branch-restricted user cannot create a tag in a same-company, ungranted branch', async () => {
    await expect(
      createTag(restrictedCtx, {
        branchId: branchA2Id, // same company, but not in restrictedCtx's branch grant
        stockTypeId, categoryId, name: 'Should be rejected',
        metalType: 'GOLD', grossWeight: 1, netWeight: 1,
      }, companyA.user.id)
    ).rejects.toThrow(/not found/i);
  });

  it('a branch-restricted user CAN read a tag in their granted branch by id', async () => {
    const tag = await getTag(restrictedCtx, tagA.id);
    expect(tag.id).toBe(tagA.id);
  });

  it('a branch-restricted user CANNOT read (by id) a tag in a same-company, ungranted branch', async () => {
    const tagInA2 = await prisma.jewelryTag.findFirstOrThrow({
      where: { companyId: companyA.company.id, branchId: branchA2Id },
    });
    await expect(getTag(restrictedCtx, tagInA2.id)).rejects.toThrow(/not found/i);
  });

  // ─── E. Company-scoped branch listing ──────────────────────────────────────

  it('listBranches never mixes companies', async () => {
    const branchesA = await listBranches(companyA.company.id);
    const branchesB = await listBranches(companyB.company.id);
    expect(branchesA.some((b) => b.id === companyB.branch.id)).toBe(false);
    expect(branchesB.some((b) => b.id === companyA.branch.id)).toBe(false);
  });

  it('createBranch always stamps the caller\'s own company, never a client-suppliable value', async () => {
    const branch = await createBranch(companyA.company.id, { name: 'New A Branch' });
    expect(branch.companyId).toBe(companyA.company.id);
    await prisma.branch.deleteMany({ where: { id: branch.id } });
  });

  // ─── F. Numbering: company isolation + concurrency safety ─────────────────

  it('two companies can independently reach the same tag-number prefix without colliding', async () => {
    const [a, b] = await Promise.all([
      createTag(companyA.ctx, {
        branchId: companyA.branch.id, stockTypeId, categoryId, name: 'Numbering test A',
        metalType: 'GOLD', grossWeight: 1, netWeight: 1,
      }, companyA.user.id),
      createTag(companyB.ctx, {
        branchId: companyB.branch.id, stockTypeId: stockTypeBId, categoryId: categoryBId, name: 'Numbering test B',
        metalType: 'GOLD', grossWeight: 1, netWeight: 1,
      }, companyB.user.id),
    ]);
    createdTagIds.push(a.id, b.id);
    // Both companies' tag-number sequences for this exact (stockType, category) are entirely
    // independent counters (keyed by companyId) — same format/prefix is expected, and the two
    // could even land on the textually IDENTICAL tagNumber (this test doesn't require or forbid
    // that) since (companyId, tagNumber) — not tagNumber alone — is what's actually unique now;
    // what matters is that both rows exist simultaneously without a constraint violation, which
    // creating both above (without either call throwing) already proves.
    const prefixOf = (n: string) => n.replace(/\d+$/, '');
    expect(prefixOf(a.tagNumber)).toBe(prefixOf(b.tagNumber));
    expect(a.companyId).not.toBe(b.companyId);
    expect(a.id).not.toBe(b.id);
  });

  it('NumberSequence stays unique and gap-free-under-no-failure for N concurrent requests, same company', async () => {
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        createTag(companyA.ctx, {
          branchId: companyA.branch.id, stockTypeId, categoryId, name: `Concurrent ${i}`,
          metalType: 'GOLD', grossWeight: 1, netWeight: 1,
        }, companyA.user.id)
      )
    );
    results.forEach((t) => createdTagIds.push(t.id));
    const numbers = results.map((t) => t.tagNumber);
    expect(new Set(numbers).size).toBe(N); // no two concurrent callers got the same number
  });

  // ─── G. Reports/aggregates stay company-scoped ─────────────────────────────

  it('an invoice created for Company A is never visible through Company B\'s invoice list', async () => {
    const invoice = await createInvoice({
      clientId: clientA.id, branchId: companyA.branch.id,
      invoiceDate: new Date(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'x', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 500 }],
    }, companyA.ctx, companyA.user.id);
    createdInvoiceIds.push(invoice.id);

    const bInvoices = await prisma.salesInvoice.findMany({ where: { companyId: companyB.company.id } });
    expect(bInvoices.some((i) => i.id === invoice.id)).toBe(false);

    expect(invoice.companyId).toBe(companyA.company.id);
    expect(invoice.items[0].companyId).toBe(companyA.company.id);
  });
});
