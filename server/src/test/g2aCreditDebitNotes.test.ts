import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { tenantQuery } from '../shared/tenantContext';
import { createTestTenant, cleanupTestTenant, TestTenant, withForcedRls } from './fixtures';

// ═══════════════════════════════════════════════════════════════════════════
// G2a — Credit Note / Debit Note foundation: schema, tenant ownership, RLS. No service/route/UI
// exists yet (see CLAUDE.md's G2a entry) — these tests exercise the database contract directly:
// the composite foreign keys (CLAUDE.md §11 item 6) and the tenant_isolation RLS policy the new
// migration (20260929120000_g2a_credit_debit_notes_foundation) adds for all six new tables.
//
// All six of `credit_notes`/`credit_note_items`/`debit_notes`/`debit_note_items`/
// `credit_note_templates`/`debit_note_templates` are FORCE ROW LEVEL SECURITY from the moment
// their migration runs (same as company_gst_registrations/tax_invoice_templates in G1) — unlike
// the OLDER tables this test file also touches as parent fixtures (clients, sales_invoices, ...),
// which predate FORCE RLS ever being applied in this single-role dev/test database (db-secure.sql,
// the thing that would apply it to them, cannot run here — see the G1 test file's own note). So
// every write to one of the six new tables goes through tenantQuery (sets app.tenant_company_id
// for that one statement); every write to an older fixture table uses the platform client bare,
// exactly like every other existing test file in this suite.
// ═══════════════════════════════════════════════════════════════════════════

interface Fixture {
  client: { id: string };
  supplier: { id: string };
  invoice: { id: string };
  invoiceItem: { id: string };
  salesReturn: { id: string };
  po: { id: string };
  grn: { id: string };
  purchaseReturn: { id: string };
}

async function bringUpFixture(tenant: TestTenant, tag: string): Promise<Fixture> {
  const companyId = tenant.company.id;
  const client = await prisma.client.create({ data: { companyId, clientCode: `G2ACL-${tag}`, name: `G2A Client ${tag}`, type: 'RETAIL' } });
  const supplier = await prisma.supplier.create({ data: { companyId, supplierCode: `G2ASUP-${tag}`, name: `G2A Supplier ${tag}`, type: 'OTHER' } });
  const invoice = await prisma.salesInvoice.create({
    data: { companyId, branchId: tenant.branch.id, invoiceNumber: `G2AINV-${tag}`, clientId: client.id, invoiceDate: new Date(), invoiceType: 'RETAIL', subtotal: 1000, totalAmount: 1000, balanceDue: 1000 },
  });
  const invoiceItem = await prisma.invoiceItem.create({
    data: {
      companyId, invoiceId: invoice.id, productCode: 'G2A-ITEM', description: 'G2A test line', quantity: 1,
      grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 1000, makingCharge: 0, unitPrice: 1000, totalPrice: 1000, taxRate: 0.03,
    },
  });
  const salesReturn = await prisma.salesReturn.create({
    data: { companyId, returnNumber: `G2ARTN-${tag}`, invoiceId: invoice.id, clientId: client.id, totalAmount: 100 },
  });
  const po = await prisma.purchaseOrder.create({
    data: { companyId, poNumber: `G2APO-${tag}`, supplierId: supplier.id, poType: 'METAL', orderDate: new Date(), subtotal: 1, totalAmount: 1 },
  });
  const grn = await prisma.goodsReceiptNote.create({
    data: { companyId, grnNumber: `G2AGRN-${tag}`, poId: po.id, receivedDate: new Date() },
  });
  const purchaseReturn = await prisma.purchaseReturn.create({
    data: { companyId, returnNumber: `G2APRTN-${tag}`, supplierId: supplier.id, totalAmount: 100 },
  });
  return { client, supplier, invoice, invoiceItem, salesReturn, po, grn, purchaseReturn };
}

/** A minimal, valid CreditNote row for `tenant`, referencing only its OWN fixture's parents. */
function creditNoteData(tenant: TestTenant, f: Fixture, tag: string, extra: Record<string, unknown> = {}) {
  return {
    companyId: tenant.company.id, creditNoteNumber: `G2ACN-${tag}`, financialYear: 2026, invoiceId: f.invoice.id,
    originalInvoiceNumber: `G2AINV-${tag}`, originalInvoiceDate: new Date(), clientId: f.client.id,
    reasonCode: 'SALES_RETURN', gstin: '24AAAAA0000A1Z5', placeOfSupply: '24', taxableAmount: 100, totalTax: 3, totalAmount: 103,
    ...extra,
  };
}

/** A minimal, valid DebitNote row for `tenant`, referencing only its OWN fixture's parents. */
function debitNoteData(tenant: TestTenant, f: Fixture, tag: string, extra: Record<string, unknown> = {}) {
  return {
    companyId: tenant.company.id, debitNoteNumber: `G2ADN-${tag}`, financialYear: 2026, grnId: f.grn.id, supplierId: f.supplier.id,
    reasonCode: 'PURCHASE_RETURN', taxableAmount: 100, totalTax: 3, totalAmount: 103,
    ...extra,
  };
}

describe('G2a: CreditNote/DebitNote/CreditNoteTemplate/DebitNoteTemplate foundation', () => {
  const suffix = `g2a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant;
  let B: TestTenant;
  let fA: Fixture;
  let fB: Fixture;
  // one legitimate, same-company row per model per tenant — reused across the SELECT-scoping RLS
  // proofs and as the valid parent for the CreditNoteItem/DebitNoteItem ownership tests.
  let creditNoteA: { id: string };
  let creditNoteB: { id: string };
  let debitNoteA: { id: string };
  let debitNoteB: { id: string };
  let templateA: { id: string };
  let templateB: { id: string };

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, []);
    B = await createTestTenant(`${suffix}B`, []);
    fA = await bringUpFixture(A, `${suffix}A`);
    fB = await bringUpFixture(B, `${suffix}B`);

    creditNoteA = await tenantQuery(A.company.id, (tx) => tx.creditNote.create({ data: creditNoteData(A, fA, `${suffix}A`) }));
    creditNoteB = await tenantQuery(B.company.id, (tx) => tx.creditNote.create({ data: creditNoteData(B, fB, `${suffix}B`) }));
    debitNoteA = await tenantQuery(A.company.id, (tx) => tx.debitNote.create({ data: debitNoteData(A, fA, `${suffix}A`) }));
    debitNoteB = await tenantQuery(B.company.id, (tx) => tx.debitNote.create({ data: debitNoteData(B, fB, `${suffix}B`) }));
    templateA = await tenantQuery(A.company.id, (tx) => tx.creditNoteTemplate.create({ data: { companyId: A.company.id, name: `G2A Template ${suffix}A`, layout: {} } }));
    templateB = await tenantQuery(B.company.id, (tx) => tx.creditNoteTemplate.create({ data: { companyId: B.company.id, name: `G2A Template ${suffix}B`, layout: {} } }));
  }, 60_000);

  afterAll(async () => {
    for (const t of [A, B]) {
      await tenantQuery(t.company.id, (tx) => tx.creditNoteItem.deleteMany({ where: { companyId: t.company.id } }));
      await tenantQuery(t.company.id, (tx) => tx.debitNoteItem.deleteMany({ where: { companyId: t.company.id } }));
      await tenantQuery(t.company.id, (tx) => tx.creditNote.deleteMany({ where: { companyId: t.company.id } }));
      await tenantQuery(t.company.id, (tx) => tx.debitNote.deleteMany({ where: { companyId: t.company.id } }));
      await tenantQuery(t.company.id, (tx) => tx.creditNoteTemplate.deleteMany({ where: { companyId: t.company.id } }));
      await tenantQuery(t.company.id, (tx) => tx.debitNoteTemplate.deleteMany({ where: { companyId: t.company.id } }));
    }
    // cleanupTestTenant's own Wave 4 deletes purchaseOrder BEFORE goodsReceiptNote (it assumes a
    // test's GRN is already gone by the time it runs) — since we created a bare GRN pointing at
    // our own bare PO, delete both ourselves first so that ordering assumption isn't violated.
    await prisma.goodsReceiptNote.deleteMany({ where: { id: { in: [fA.grn.id, fB.grn.id] } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: [fA.po.id, fB.po.id] } } });
    // cleanupTestTenant does not delete Client rows at all (same as g1GstFoundation.test.ts) — and
    // clients_companyId_fkey is RESTRICT, so a live Client blocks its own company's final delete.
    // Everything that references OUR client (invoiceItem/salesReturn/salesInvoice) must go first;
    // cleanupTestTenant would remove them too, but only later, after it already tried the company.
    await prisma.invoiceItem.deleteMany({ where: { id: { in: [fA.invoiceItem.id, fB.invoiceItem.id] } } });
    await prisma.salesReturn.deleteMany({ where: { id: { in: [fA.salesReturn.id, fB.salesReturn.id] } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: [fA.invoice.id, fB.invoice.id] } } });
    await prisma.client.deleteMany({ where: { id: { in: [fA.client.id, fB.client.id] } } });
    await cleanupTestTenant(A);
    await cleanupTestTenant(B);
    await prisma.$disconnect();
  });

  // ─── Tenant ownership: the nine required cross-company cases (CLAUDE.md G2a spec §12), plus the
  // two composite FKs (CreditNoteItem->CreditNote, DebitNoteItem->DebitNote) required by §7 but not
  // separately listed there. Every attempt runs with the RIGHT company's session (RLS WITH CHECK
  // passes — companyId matches) so what actually fails is the FK: the database, not RLS, is what's
  // being proven here, exactly like compositeFk.test.ts's existing 58+ relations. ───

  const FK = /foreign key|violates/i;

  it('CreditNote referencing another company\'s SalesInvoice is rejected', async () => {
    await expect(tenantQuery(A.company.id, (tx) => tx.creditNote.create({
      data: creditNoteData(A, fA, `${suffix}FK1`, { creditNoteNumber: `G2ACN-FK1-${suffix}`, invoiceId: fB.invoice.id }),
    }))).rejects.toThrow(FK);
  });

  it('CreditNote referencing another company\'s SalesReturn is rejected', async () => {
    await expect(tenantQuery(A.company.id, (tx) => tx.creditNote.create({
      data: creditNoteData(A, fA, `${suffix}FK2`, { creditNoteNumber: `G2ACN-FK2-${suffix}`, salesReturnId: fB.salesReturn.id }),
    }))).rejects.toThrow(FK);
  });

  it('CreditNote referencing another company\'s Client is rejected', async () => {
    await expect(tenantQuery(A.company.id, (tx) => tx.creditNote.create({
      data: creditNoteData(A, fA, `${suffix}FK3`, { creditNoteNumber: `G2ACN-FK3-${suffix}`, clientId: fB.client.id }),
    }))).rejects.toThrow(FK);
  });

  it('CreditNoteItem referencing another company\'s InvoiceItem is rejected', async () => {
    await expect(tenantQuery(A.company.id, (tx) => tx.creditNoteItem.create({
      data: {
        companyId: A.company.id, creditNoteId: creditNoteA.id, invoiceItemId: fB.invoiceItem.id,
        description: 'forged line', taxRate: 0.03,
      },
    }))).rejects.toThrow(FK);
  });

  it('CreditNoteItem referencing another company\'s CreditNote is rejected (§7 composite FK, not separately in the 9-case list)', async () => {
    await expect(tenantQuery(A.company.id, (tx) => tx.creditNoteItem.create({
      data: { companyId: A.company.id, creditNoteId: creditNoteB.id, description: 'forged parent', taxRate: 0.03 },
    }))).rejects.toThrow(FK);
  });

  it('DebitNote referencing another company\'s GoodsReceiptNote is rejected', async () => {
    await expect(tenantQuery(A.company.id, (tx) => tx.debitNote.create({
      data: debitNoteData(A, fA, `${suffix}FK5`, { debitNoteNumber: `G2ADN-FK5-${suffix}`, grnId: fB.grn.id }),
    }))).rejects.toThrow(FK);
  });

  it('DebitNote referencing another company\'s PurchaseReturn is rejected', async () => {
    await expect(tenantQuery(A.company.id, (tx) => tx.debitNote.create({
      data: debitNoteData(A, fA, `${suffix}FK6`, { debitNoteNumber: `G2ADN-FK6-${suffix}`, purchaseReturnId: fB.purchaseReturn.id }),
    }))).rejects.toThrow(FK);
  });

  it('DebitNote referencing another company\'s Supplier is rejected', async () => {
    await expect(tenantQuery(A.company.id, (tx) => tx.debitNote.create({
      data: debitNoteData(A, fA, `${suffix}FK7`, { debitNoteNumber: `G2ADN-FK7-${suffix}`, supplierId: fB.supplier.id }),
    }))).rejects.toThrow(FK);
  });

  it('DebitNoteItem referencing another company\'s DebitNote is rejected (§7 composite FK, not separately in the 9-case list)', async () => {
    await expect(tenantQuery(A.company.id, (tx) => tx.debitNoteItem.create({
      data: { companyId: A.company.id, debitNoteId: debitNoteB.id, description: 'forged parent', taxRate: 0.03 },
    }))).rejects.toThrow(FK);
  });

  it('CreditNoteTemplate referencing another company\'s Branch is rejected', async () => {
    await expect(tenantQuery(A.company.id, (tx) => tx.creditNoteTemplate.create({
      data: { companyId: A.company.id, name: `G2A Forged Template ${suffix}`, branchId: B.branch.id, layout: {} },
    }))).rejects.toThrow(FK);
  });

  it('DebitNoteTemplate referencing another company\'s Branch is rejected', async () => {
    await expect(tenantQuery(A.company.id, (tx) => tx.debitNoteTemplate.create({
      data: { companyId: A.company.id, name: `G2A Forged Template ${suffix}`, branchId: B.branch.id, layout: {} },
    }))).rejects.toThrow(FK);
  });

  it('control: the same writes pointing at the company\'s OWN parents succeed (the keys do not block legitimate use)', async () => {
    const item = await tenantQuery(A.company.id, (tx) => tx.creditNoteItem.create({
      data: { companyId: A.company.id, creditNoteId: creditNoteA.id, invoiceItemId: fA.invoiceItem.id, description: 'ok line', taxRate: 0.03 },
    }));
    expect(item.id).toBeTruthy();
    const dItem = await tenantQuery(A.company.id, (tx) => tx.debitNoteItem.create({
      data: { companyId: A.company.id, debitNoteId: debitNoteA.id, description: 'ok line', taxRate: 0.03 },
    }));
    expect(dItem.id).toBeTruthy();
  });

  it('nothing persists after a rejected forgery: CreditNote row count for company A is unchanged by the failed attempts above', async () => {
    const count = await tenantQuery(A.company.id, (tx) => tx.creditNote.count({ where: { companyId: A.company.id } }));
    expect(count).toBe(1); // only creditNoteA
  });

  // ─── RLS: the tenant_isolation policy on all six new tables (representative coverage: a document
  // table with full SELECT/fail-closed/UPDATE/INSERT-WITH-CHECK treatment, a child/item table and a
  // template table with a lighter SELECT-scope proof — same sampling approach as rls.phase3.test.ts,
  // not a new framework). ───

  describe('RLS: credit_notes', () => {
    it('a session scoped to Company A never sees Company B\'s credit note', async () => {
      await withForcedRls(['credit_notes'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        const rows = await tx.creditNote.findMany({ where: { id: { in: [creditNoteA.id, creditNoteB.id] } } });
        expect(rows.map((r: any) => r.id)).toEqual([creditNoteA.id]);
      });
    });

    it('fail-closed: no session variable set means zero rows, not every row', async () => {
      await withForcedRls(['credit_notes'], async (tx) => {
        const rows = await tx.creditNote.findMany({ where: { id: { in: [creditNoteA.id, creditNoteB.id] } } });
        expect(rows).toHaveLength(0);
      });
    });

    it('UPDATE cannot touch a row outside the session\'s company', async () => {
      await withForcedRls(['credit_notes'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        const result = await tx.creditNote.updateMany({ where: { id: creditNoteB.id }, data: { reasonCode: 'HACKED' } });
        expect(result.count).toBe(0);
      });
    });

    it('WITH CHECK rejects an INSERT whose companyId doesn\'t match the active session', async () => {
      await withForcedRls(['credit_notes'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        await expect(tx.creditNote.create({
          data: creditNoteData(B, fB, `${suffix}RLSFORGE`, { creditNoteNumber: `G2ACN-RLSFORGE-${suffix}` }),
        })).rejects.toThrow();
      });
    });
  });

  describe('RLS: debit_notes', () => {
    it('a session scoped to Company A never sees Company B\'s debit note', async () => {
      await withForcedRls(['debit_notes'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        const rows = await tx.debitNote.findMany({ where: { id: { in: [debitNoteA.id, debitNoteB.id] } } });
        expect(rows.map((r: any) => r.id)).toEqual([debitNoteA.id]);
      });
    });

    it('WITH CHECK rejects an INSERT whose companyId doesn\'t match the active session', async () => {
      await withForcedRls(['debit_notes'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        await expect(tx.debitNote.create({
          data: debitNoteData(B, fB, `${suffix}RLSFORGE`, { debitNoteNumber: `G2ADN-RLSFORGE-${suffix}` }),
        })).rejects.toThrow();
      });
    });
  });

  describe('RLS: item/template tables (SELECT-scope sample)', () => {
    it('credit_note_items: a session scoped to Company A never sees Company B\'s line', async () => {
      const itemB = await tenantQuery(B.company.id, (tx) => tx.creditNoteItem.create({
        data: { companyId: B.company.id, creditNoteId: creditNoteB.id, description: 'B line', taxRate: 0.03 },
      }));
      await withForcedRls(['credit_note_items'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        const rows = await tx.creditNoteItem.findMany({ where: { id: itemB.id } });
        expect(rows).toHaveLength(0);
      });
    });

    it('credit_note_templates: a session scoped to Company A never sees Company B\'s template', async () => {
      await withForcedRls(['credit_note_templates'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        const rows = await tx.creditNoteTemplate.findMany({ where: { id: { in: [templateA.id, templateB.id] } } });
        expect(rows.map((r: any) => r.id)).toEqual([templateA.id]);
      });
    });

    it('debit_note_templates: a session scoped to Company A never sees Company B\'s template', async () => {
      const dTemplateA = await tenantQuery(A.company.id, (tx) => tx.debitNoteTemplate.create({ data: { companyId: A.company.id, name: `G2A DN Template ${suffix}A`, layout: {} } }));
      const dTemplateB = await tenantQuery(B.company.id, (tx) => tx.debitNoteTemplate.create({ data: { companyId: B.company.id, name: `G2A DN Template ${suffix}B`, layout: {} } }));
      await withForcedRls(['debit_note_templates'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        const rows = await tx.debitNoteTemplate.findMany({ where: { id: { in: [dTemplateA.id, dTemplateB.id] } } });
        expect(rows.map((r: any) => r.id)).toEqual([dTemplateA.id]);
      });
    });
  });
});
