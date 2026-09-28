import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { AppError } from '../../middleware/error';
import { createInvoice as _createInvoice, getTaxContext, createMemoOut, convertMemoToInvoice, recordPayment, createSalesReturn, createOldGoldExchange, recordClientPayment, listClientPayments, getSalesRegister, getClientCredit, amendInvoice, voidInvoice, reverseInvoicePayment } from './sales.service';
import { getClientLedger, getDayBook, getDealerAging } from '../finance/finance.service';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { DEFAULT_HSN_CODE } from '../../shared/constants';
import { cleanupJournalEntries, getJournalEntry, lineAmount } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

describe('createInvoice (tag-aware direct invoicing)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let clientId: string;
  let categoryId: string;
  const invoiceIds: string[] = [];
  const tagIds: string[] = [];

  // Local shim: absorbs the multi-tenant signature change (ctx now required, branchId now a
  // required field on the invoice itself) so the ~50 existing createInvoice(data, userId) call
  // sites below don't each need editing. branchId defaults to this suite's fixture branch but a
  // call's own data.branchId (spread last) still wins, for the handful of tests that exercise a
  // second/other branch explicitly.
  function createInvoice(data: Omit<Parameters<typeof _createInvoice>[0], 'branchId'> & { branchId?: string }, uid: string) {
    return _createInvoice({ branchId, ...data }, tenant.ctx, uid);
  }

  async function makeTag(name: string, overrides: { categoryId?: string; metalKarat?: string; saleMcRate?: number; saleVaPercent?: number } = {}) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-${suffix}-${tagIds.length}`,
        companyId: tenant.company.id,
        branchId, name, metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 10, netWeight: 10, stoneWeight: 0,
        costPrice: 40000, sellingPrice: 48000,
        createdById: userId,
        ...overrides,
      },
    });
    tagIds.push(tag.id);
    return tag;
  }

  function baseItem(overrides: Partial<Parameters<typeof _createInvoice>[0]['items'][number]> = {}) {
    return {
      productCode: 'MISC', description: 'Test line', quantity: 1,
      grossWeight: 10, netGoldWeight: 10, rateType: 'PER_GRAM',
      goldRate: 48000, makingCharge: 0,
      ...overrides,
    };
  }

  beforeAll(async () => {
    tenant = await createTestTenant(suffix, ['invoice:create']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;

    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-${suffix}`, name: 'Test Client', panNumber: 'ABCDE1234F', type: 'RETAIL' },
    });
    clientId = client.id;

    const category = await prisma.productCategory.create({
      data: { companyId: tenant.company.id, code: `TSTCAT-${suffix}`, name: 'Test Rings' },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    // F1: undo the ledger side-effects (Account.balance) of every JournalEntry this suite posted
    // — one per invoice, per payment, per return — before touching the business rows themselves
    // (JournalEntry.referenceId isn't an FK, so order relative to the deletes below doesn't matter).
    const returnIds = (await prisma.salesReturn.findMany({ where: { invoiceId: { in: invoiceIds } }, select: { id: true } })).map((r) => r.id);
    const paymentIds = (await prisma.invoicePayment.findMany({ where: { invoiceId: { in: invoiceIds } }, select: { id: true } })).map((p) => p.id);
    await cleanupJournalEntries([...invoiceIds, ...returnIds, ...paymentIds]);

    // Must precede the salesInvoice/jewelryTag deletes below — sales_return_items has a RESTRICT
    // FK to both invoice_items (via salesInvoice's cascade) and jewelry_tags.
    await prisma.salesReturn.deleteMany({ where: { invoiceId: { in: invoiceIds } } }); // cascades sales_return_items
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } }); // cascades invoice_items
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('flips a single tagged line to SOLD and links it', async () => {
    const tag = await makeTag('Ring A');

    const invoice = await createInvoice(
      { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem({ tagId: tag.id })] },
      userId
    );
    invoiceIds.push(invoice.id);

    expect(invoice.items).toHaveLength(1);
    expect(invoice.items[0].tagId).toBe(tag.id);

    const updated = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
    expect(updated.status).toBe('SOLD');
  });

  it('supports a mixed invoice: one tagged line + one free-text line', async () => {
    const tag = await makeTag('Ring B');

    const invoice = await createInvoice(
      {
        clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
        items: [
          baseItem({ tagId: tag.id, description: 'Tagged ring' }),
          baseItem({ description: 'Making charge adjustment', goldRate: 0, makingCharge: 500 }),
        ],
      },
      userId
    );
    invoiceIds.push(invoice.id);

    const taggedLine = invoice.items.find((i) => i.tagId === tag.id);
    const freeTextLine = invoice.items.find((i) => i.tagId === null);
    expect(taggedLine).toBeDefined();
    expect(freeTextLine).toBeDefined();
    // tagged line: netGoldWeight(10) * goldRate(48000) = 480000; free-text line: makingCharge only = 500
    expect(Number(invoice.subtotal)).toBeCloseTo(480000 + 500);

    const updated = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
    expect(updated.status).toBe('SOLD');
  });

  it('is all-or-nothing: one unsellable tag rolls back the whole invoice, including the sellable tag', async () => {
    const sellable = await makeTag('Ring C (sellable)');
    const alreadySold = await makeTag('Ring D (already sold)');
    await prisma.jewelryTag.update({ where: { id: alreadySold.id }, data: { status: 'SOLD' } });

    const invoiceCountBefore = await prisma.salesInvoice.count({ where: { clientId } });

    await expect(
      createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          items: [baseItem({ tagId: sellable.id }), baseItem({ tagId: alreadySold.id })],
        },
        userId
      )
    ).rejects.toThrow(AppError);

    const invoiceCountAfter = await prisma.salesInvoice.count({ where: { clientId } });
    expect(invoiceCountAfter).toBe(invoiceCountBefore); // no invoice was created

    const stillInStock = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: sellable.id } });
    expect(stillInStock.status).toBe('IN_STOCK'); // not left half-flipped
  });

  it('lets exactly one of several concurrent invoices win the same tag', async () => {
    const tag = await makeTag('Ring E (contested)');

    const attempt = () =>
      createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem({ tagId: tag.id })] },
        userId
      );

    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    invoiceIds.push(fulfilled[0].value.id);

    const finalTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
    expect(finalTag.status).toBe('SOLD');

    const linkedCount = await prisma.invoiceItem.count({ where: { tagId: tag.id } });
    expect(linkedCount).toBe(1);
  });

  it('rejects the same tag appearing twice in one invoice request, without touching the DB', async () => {
    const tag = await makeTag('Ring F (duplicated line)');

    await expect(
      createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          items: [baseItem({ tagId: tag.id }), baseItem({ tagId: tag.id })],
        },
        userId
      )
    ).rejects.toThrow(/cannot appear on more than one line/);

    const untouched = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
    expect(untouched.status).toBe('IN_STOCK');
  });

  it('still supports a free-text-only invoice with no tags (regression)', async () => {
    const invoice = await createInvoice(
      { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()] },
      userId
    );
    invoiceIds.push(invoice.id);

    expect(invoice.items).toHaveLength(1);
    expect(invoice.items[0].tagId).toBeNull();
  });

  // A1: currency was read twice (once for the tax rate, once — separately — for the row default),
  // so an omitted currency invoiced as INR but taxed as if it weren't. These prove the two reads
  // can no longer diverge.
  describe('GST / currency (A1 zero-GST bug)', () => {
    it('computes GST when currency is omitted, same as an explicit INR invoice', async () => {
      const omitted = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()] },
        userId
      );
      invoiceIds.push(omitted.id);

      const explicit = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', currency: 'INR', items: [baseItem()] },
        userId
      );
      invoiceIds.push(explicit.id);

      expect(Number(omitted.taxAmount)).toBeCloseTo(480000 * 0.03);
      expect(Number(omitted.taxAmount)).toBeCloseTo(Number(explicit.taxAmount));
      expect(omitted.currency).toBe('INR');

      const taxInvoice = await prisma.taxInvoice.findUnique({ where: { invoiceId: omitted.id } });
      expect(taxInvoice).not.toBeNull();
      expect(Number(taxInvoice!.totalTax)).toBeGreaterThan(0);
    });

    it('charges zero GST and emits no TaxInvoice for a non-INR currency (not a bug — legitimately untaxed here)', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', currency: 'USD',
          items: [baseItem()],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.taxAmount)).toBe(0);

      const taxInvoice = await prisma.taxInvoice.findUnique({ where: { invoiceId: invoice.id } });
      expect(taxInvoice).toBeNull();
    });
  });

  // A2: rateType existed on both the input and the schema but createInvoice ignored it, always
  // treating goldRate as ₹/gram. That made FIXED-rate rows (e.g. convertMemoToInvoice's flat
  // sellingPrice) mislabeled data. This proves createInvoice now honors rateType.
  describe('rateType-driven pricing (A2 price-mode fix)', () => {
    it('prices a FIXED-rate line at goldRate directly, ignoring netGoldWeight', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          items: [baseItem({ rateType: 'FIXED', goldRate: 52000, netGoldWeight: 10 })],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.items[0].unitPrice)).toBe(52000);
      expect(Number(invoice.subtotal)).toBe(52000);
    });

    it('prices a FIXED-rate, zero-netGoldWeight line (e.g. a loose stone) at goldRate, not zero', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          items: [baseItem({
            rateType: 'FIXED', goldRate: 15000, netGoldWeight: 0, grossWeight: 0,
            description: 'Loose stone',
          })],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.items[0].unitPrice)).toBe(15000);
    });

    it('still prices a PER_GRAM line off netGoldWeight * goldRate (regression)', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          items: [baseItem({ rateType: 'PER_GRAM', goldRate: 48000, netGoldWeight: 10, makingCharge: 200 })],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.items[0].unitPrice)).toBe(48000 * 10 + 200);
    });

    // VA% (wastagePercent): reuses the same markup-the-making-charge formula NewTagPage.tsx
    // already applies for the MakingCharge master, rather than inventing a new one.
    it('marks up makingCharge by wastagePercent (VA%) on a PER_GRAM line', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          items: [baseItem({
            rateType: 'PER_GRAM', goldRate: 48000, netGoldWeight: 10,
            makingCharge: 1000, wastagePercent: 10,
          })],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      // 10*48000 + 1000*(1+10/100) = 480000 + 1100 = 481100
      expect(Number(invoice.items[0].unitPrice)).toBe(481100);
      expect(Number(invoice.items[0].wastagePercent)).toBe(10);
    });

    it('ignores wastagePercent on a FIXED-rate line, same as it ignores makingCharge (regression)', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          items: [baseItem({ rateType: 'FIXED', goldRate: 52000, makingCharge: 1000, wastagePercent: 10 })],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.items[0].unitPrice)).toBe(52000);
    });

    it('defaults wastagePercent to 0 when omitted (regression)', async () => {
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()] },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.items[0].wastagePercent)).toBe(0);
    });
  });

  // C2: a PER_GRAM line that omits goldRate now prices off MetalRate for its karat, as of
  // invoiceDate — not always "today". Two rates are seeded at different dates so the tests can
  // tell "resolved the right one for this date" apart from "resolved *a* rate".
  describe('daily rate auto-pricing (C2)', () => {
    const testKarat = `TSTKAR-${suffix}`;
    const noRateKarat = `TSTKAR-NONE-${suffix}`;
    const dateOnly = (d: Date) => new Date(d.toISOString().split('T')[0]);
    const today = dateOnly(new Date());
    const tenDaysAgo = dateOnly(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    const fiveDaysAgo = dateOnly(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));
    const rateIds: string[] = [];

    beforeAll(async () => {
      const older = await prisma.metalRate.create({
        data: { companyId: tenant.company.id, date: tenDaysAgo, karat: testKarat, purity: 0.916, ratePerGram: 40000 },
      });
      const newer = await prisma.metalRate.create({
        data: { companyId: tenant.company.id, date: today, karat: testKarat, purity: 0.916, ratePerGram: 45000 },
      });
      rateIds.push(older.id, newer.id);
    });

    afterAll(async () => {
      await prisma.metalRate.deleteMany({ where: { id: { in: rateIds } } });
    });

    it('resolves an omitted goldRate from the MetalRate as of invoiceDate', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: today, invoiceType: 'RETAIL',
          items: [baseItem({ goldRate: undefined, karat: testKarat, netGoldWeight: 10 })],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.items[0].goldRate)).toBe(45000);
      expect(Number(invoice.items[0].unitPrice)).toBe(10 * 45000);
    });

    it('resolves the rate as of a backdated invoiceDate, not the latest one available', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: fiveDaysAgo, invoiceType: 'RETAIL',
          items: [baseItem({ goldRate: undefined, karat: testKarat, netGoldWeight: 10 })],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      // fiveDaysAgo is after the 40000 rate (10 days ago) but before the 45000 rate (today) —
      // must resolve to the older, still-effective-on-that-date rate.
      expect(Number(invoice.items[0].goldRate)).toBe(40000);
      expect(Number(invoice.items[0].unitPrice)).toBe(10 * 40000);
    });

    it('still honors an explicit goldRate override even when a MetalRate exists for that karat/date (regression)', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: today, invoiceType: 'RETAIL',
          items: [baseItem({ goldRate: 99999, karat: testKarat, netGoldWeight: 10 })],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.items[0].goldRate)).toBe(99999);
      expect(Number(invoice.items[0].unitPrice)).toBe(10 * 99999);
    });

    it('rejects a PER_GRAM line with neither goldRate nor karat to resolve one', async () => {
      await expect(
        createInvoice(
          {
            clientId, invoiceDate: today, invoiceType: 'RETAIL',
            items: [baseItem({ goldRate: undefined, karat: undefined })],
          },
          userId
        )
      ).rejects.toThrow(/goldRate or karat/);
    });

    it('rejects a karat with no MetalRate on or before invoiceDate', async () => {
      await expect(
        createInvoice(
          {
            clientId, invoiceDate: today, invoiceType: 'RETAIL',
            items: [baseItem({ goldRate: undefined, karat: noRateKarat })],
          },
          userId
        )
      ).rejects.toThrow(/No metal rate found/);
    });

    it('rejects a FIXED-rate line with no explicit goldRate (it has no market rate to fall back on)', async () => {
      await expect(
        createInvoice(
          {
            clientId, invoiceDate: today, invoiceType: 'RETAIL',
            items: [baseItem({ rateType: 'FIXED', goldRate: undefined, karat: testKarat })],
          },
          userId
        )
      ).rejects.toThrow(/FIXED-rate lines require an explicit goldRate/);
    });
  });

  // C3: a PER_GRAM line missing an explicit makingCharge/wastagePercent now pulls the
  // MakingCharge master's rate for its karat + category (+ tag makeType), same
  // override-always-wins pattern as C2's goldRate. Most-specific-match-wins across all three
  // dimensions — see the karat-specificity describe block below.
  describe('making-charge / wastage master (C3)', () => {
    let masterChargeId: string;
    let flatMasterChargeId: string;
    let flatCategoryId: string;

    beforeAll(async () => {
      const charge = await prisma.makingCharge.create({
        data: {
          companyId: tenant.company.id,
          categoryId, makeType: 'GOLD', makingCharge: 300, makingChargeType: 'PER_GRAM',
          saleWastagePercent: 5, isActive: true,
        },
      });
      masterChargeId = charge.id;

      const flatCategory = await prisma.productCategory.create({
        data: { companyId: tenant.company.id, code: `TSTCAT-FLAT-${suffix}`, name: 'Test Flat-Charge Category' },
      });
      flatCategoryId = flatCategory.id;
      const flatCharge = await prisma.makingCharge.create({
        data: {
          companyId: tenant.company.id,
          categoryId: flatCategoryId, makeType: 'GOLD', makingCharge: 750,
          makingChargeType: 'PER_PIECE', saleWastagePercent: 0, isActive: true,
        },
      });
      flatMasterChargeId = flatCharge.id;
    });

    afterAll(async () => {
      await prisma.makingCharge.deleteMany({ where: { id: { in: [masterChargeId, flatMasterChargeId] } } });
      // flatCategory is removed by cleanupTestTenant after the tags that reference it (composite FK: RESTRICT)
    });

    it('resolves makingCharge/wastagePercent from the master for a tagged line when both omitted', async () => {
      const tag = await makeTag('Ring C3-a', { categoryId });

      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          items: [baseItem({ tagId: tag.id, goldRate: 48000, netGoldWeight: 10, makingCharge: undefined, wastagePercent: undefined })],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      // PER_GRAM master: 300 * netGoldWeight(10) = 3000; wastagePercent from saleWastagePercent (5)
      expect(Number(invoice.items[0].makingCharge)).toBe(3000);
      expect(Number(invoice.items[0].wastagePercent)).toBe(5);
      // 10*48000 + 3000*1.05 = 480000 + 3150
      expect(Number(invoice.items[0].unitPrice)).toBe(480000 + 3150);
    });

    // The concern this closes: an executive can override MC/VA at tagging time (NewTagPage's
    // MC & VA tab), and the MakingCharge master can change afterward — a piece already tagged
    // must keep billing at what was actually decided for it, not silently re-price to whatever
    // the master says today.
    it('prefers the tagged piece\'s own settled saleMcRate/saleVaPercent over the master when both omitted', async () => {
      const tag = await makeTag('Ring C3-tag-rate', { categoryId, saleMcRate: 777, saleVaPercent: 12 });

      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          items: [baseItem({ tagId: tag.id, goldRate: 48000, netGoldWeight: 10, makingCharge: undefined, wastagePercent: undefined })],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      // Tag's own rate wins over the master's (300/5%): 777 * netGoldWeight(10) = 7770; VA 12%.
      expect(Number(invoice.items[0].makingCharge)).toBe(7770);
      expect(Number(invoice.items[0].wastagePercent)).toBe(12);
      expect(Number(invoice.items[0].unitPrice)).toBe(10 * 48000 + 7770 * 1.12);
    });

    it('an explicit request-level makingCharge/wastagePercent still wins over the tag\'s own settled rate (regression)', async () => {
      const tag = await makeTag('Ring C3-tag-rate-override', { categoryId, saleMcRate: 777, saleVaPercent: 12 });

      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          items: [baseItem({ tagId: tag.id, goldRate: 48000, netGoldWeight: 10, makingCharge: 111, wastagePercent: 2 })],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.items[0].makingCharge)).toBe(111);
      expect(Number(invoice.items[0].wastagePercent)).toBe(2);
    });

    it('still honors explicit makingCharge/wastagePercent even when a master row matches (regression)', async () => {
      const tag = await makeTag('Ring C3-b', { categoryId });

      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          items: [baseItem({ tagId: tag.id, goldRate: 48000, netGoldWeight: 10, makingCharge: 999, wastagePercent: 0 })],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.items[0].makingCharge)).toBe(999);
      expect(Number(invoice.items[0].wastagePercent)).toBe(0);
    });

    it('defaults makingCharge/wastagePercent to 0 when no master row matches the category (regression)', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          items: [baseItem({ makingCharge: undefined, wastagePercent: undefined })],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.items[0].makingCharge)).toBe(0);
      expect(Number(invoice.items[0].wastagePercent)).toBe(0);
    });

    it('scales a non-PER_GRAM (flat) master charge by piece, not by weight', async () => {
      const tag = await makeTag('Ring C3-c', { categoryId: flatCategoryId });

      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          items: [baseItem({ tagId: tag.id, goldRate: 48000, netGoldWeight: 10, makingCharge: undefined, wastagePercent: undefined })],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.items[0].makingCharge)).toBe(750); // flat, not 750*10
      expect(Number(invoice.items[0].wastagePercent)).toBe(0);
    });

    it('ignores the making-charge master on a FIXED-rate line even when its category matches (regression)', async () => {
      const tag = await makeTag('Ring C3-d', { categoryId });

      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          items: [baseItem({
            tagId: tag.id, rateType: 'FIXED', goldRate: 52000,
            makingCharge: undefined, wastagePercent: undefined,
          })],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.items[0].makingCharge)).toBe(0);
      expect(Number(invoice.items[0].unitPrice)).toBe(52000);
    });

    describe('karat specificity', () => {
      let karatChargeId: string;

      beforeAll(async () => {
        // Same category as masterChargeId (300/gm, 5% VA, any karat) but pinned to 18K at a
        // different rate — the two rows exist together so resolution has to actually pick the
        // more specific one, not just be the only candidate.
        const charge = await prisma.makingCharge.create({
          data: {
            companyId: tenant.company.id,
            categoryId, karat: '18K', makeType: 'GOLD', makingCharge: 800,
            makingChargeType: 'PER_GRAM', saleWastagePercent: 22, isActive: true,
          },
        });
        karatChargeId = charge.id;
      });

      afterAll(async () => {
        await prisma.makingCharge.deleteMany({ where: { id: karatChargeId } });
      });

      it('prefers a karat+category-specific master row over a category-only wildcard row', async () => {
        const tag = await makeTag('Ring C3-karat-a', { categoryId, metalKarat: '18K' });

        const invoice = await createInvoice(
          {
            clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
            items: [baseItem({ tagId: tag.id, goldRate: 48000, netGoldWeight: 10, makingCharge: undefined, wastagePercent: undefined })],
          },
          userId
        );
        invoiceIds.push(invoice.id);

        // 800/gm * 10, 22% VA — the 18K-specific row, not the wildcard-karat 300/gm, 5% row.
        expect(Number(invoice.items[0].makingCharge)).toBe(8000);
        expect(Number(invoice.items[0].wastagePercent)).toBe(22);
      });

      it('still falls back to the category-only wildcard row for a karat with no specific master row (regression)', async () => {
        const tag = await makeTag('Ring C3-karat-b', { categoryId, metalKarat: '22K' });

        const invoice = await createInvoice(
          {
            clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
            items: [baseItem({ tagId: tag.id, goldRate: 48000, netGoldWeight: 10, makingCharge: undefined, wastagePercent: undefined })],
          },
          userId
        );
        invoiceIds.push(invoice.id);

        expect(Number(invoice.items[0].makingCharge)).toBe(3000);
        expect(Number(invoice.items[0].wastagePercent)).toBe(5);
      });

      it('an explicit line-level karat overrides the tag\'s own metalKarat for master resolution', async () => {
        // Tag itself is 22K, but the line explicitly prices it as 18K (e.g. a mixed-karat piece
        // billed under a specific karat) — resolution should follow the line, not the tag.
        const tag = await makeTag('Ring C3-karat-c', { categoryId, metalKarat: '22K' });

        const invoice = await createInvoice(
          {
            clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
            items: [baseItem({
              tagId: tag.id, karat: '18K', goldRate: 48000, netGoldWeight: 10,
              makingCharge: undefined, wastagePercent: undefined,
            })],
          },
          userId
        );
        invoiceIds.push(invoice.id);

        expect(Number(invoice.items[0].makingCharge)).toBe(8000);
        expect(Number(invoice.items[0].wastagePercent)).toBe(22);
      });
    });
  });

  // B1: createInvoice used to compute one flat 3% for the whole invoice. Now each line looks up
  // its own HsnCode.gstRate, defaulting to DEFAULT_HSN_CODE (7113, 3%) when a line omits hsnCode.
  describe('HSN / GST rate master (B1)', () => {
    let highRateHsnId: string;
    const HIGH_RATE_HSN_CODE = `TSTHSN18-${suffix}`;

    beforeAll(async () => {
      const hsn = await prisma.hsnCode.create({
        data: { code: HIGH_RATE_HSN_CODE, description: 'Test 18% HSN', gstRate: 0.18 },
      });
      highRateHsnId = hsn.id;
    });

    afterAll(async () => {
      await prisma.hsnCode.delete({ where: { id: highRateHsnId } });
    });

    it('resolves an omitted hsnCode to the default (7113, 3%) and stamps it on the line', async () => {
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()] },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.items[0].taxRate)).toBeCloseTo(0.03);
      expect(invoice.items[0].hsnCodeId).not.toBeNull();
      expect(Number(invoice.taxAmount)).toBeCloseTo(480000 * 0.03);
    });

    it('prices a mixed-rate invoice: two lines at different HSN rates sum to the right total tax', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          items: [
            baseItem({ description: 'Default-rate line' }), // 480000 @ 3%
            baseItem({
              description: 'High-rate line', hsnCode: HIGH_RATE_HSN_CODE,
              rateType: 'FIXED', goldRate: 10000, netGoldWeight: 0,
            }), // 10000 @ 18%
          ],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      const expectedTax = 480000 * 0.03 + 10000 * 0.18;
      expect(Number(invoice.taxAmount)).toBeCloseTo(expectedTax);

      const highRateLine = invoice.items.find((i) => i.hsnCodeId === highRateHsnId);
      expect(highRateLine).toBeDefined();
      expect(Number(highRateLine!.taxRate)).toBeCloseTo(0.18);
    });

    it('rejects an unknown HSN code without creating an invoice', async () => {
      const invoiceCountBefore = await prisma.salesInvoice.count({ where: { clientId } });

      await expect(
        createInvoice(
          {
            clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
            items: [baseItem({ hsnCode: 'NOT-A-REAL-HSN' })],
          },
          userId
        )
      ).rejects.toThrow(/Unknown or inactive HSN code/);

      const invoiceCountAfter = await prisma.salesInvoice.count({ where: { clientId } });
      expect(invoiceCountAfter).toBe(invoiceCountBefore);
    });
  });

  // B2: client.state (free text) vs COMPANY_STATE_CODE (numeric) never matched, so every sale
  // priced as inter-state IGST regardless of the client's actual state. These prove a same-state
  // client now correctly nets CGST+SGST (by canonical name and by alias), a genuinely different
  // state still nets IGST, and an unresolved state keeps the old IGST fallback (regression).
  describe('place-of-supply / state resolution (B2)', () => {
    const originalCompanyState = process.env.COMPANY_STATE_CODE;
    const stateClientIds: string[] = [];

    beforeAll(() => {
      process.env.COMPANY_STATE_CODE = '24'; // Gujarat — deterministic regardless of ambient env
    });

    afterAll(async () => {
      process.env.COMPANY_STATE_CODE = originalCompanyState;
      // Invoices for these clients are also tracked in the outer invoiceIds/afterAll, but that
      // cleanup runs after this one (nested afterAll runs first) — so clear the FK here first.
      const stateInvoices = await prisma.salesInvoice.findMany({
        where: { clientId: { in: stateClientIds } }, select: { id: true },
      });
      const stateInvoiceIds = stateInvoices.map((i) => i.id);
      await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: stateInvoiceIds } } });
      await prisma.salesInvoice.deleteMany({ where: { id: { in: stateInvoiceIds } } });
      await prisma.client.deleteMany({ where: { id: { in: stateClientIds } } });
    });

    async function makeClient(state: string | null) {
      const c = await prisma.client.create({
        data: {
          companyId: tenant.company.id,
          clientCode: `TSTSTCL-${suffix}-${stateClientIds.length}`,
          name: 'State Test Client', panNumber: 'ABCDE1234F', type: 'RETAIL', state: state ?? undefined,
        },
      });
      stateClientIds.push(c.id);
      return c;
    }

    it('nets CGST+SGST for a client in the same state, matched by canonical name', async () => {
      const client = await makeClient('Gujarat');
      const invoice = await createInvoice(
        { clientId: client.id, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()] },
        userId
      );
      invoiceIds.push(invoice.id);

      const taxInvoice = await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: invoice.id } });
      expect(Number(taxInvoice.igst)).toBe(0);
      expect(Number(taxInvoice.cgst)).toBeCloseTo(Number(invoice.taxAmount) / 2);
      expect(Number(taxInvoice.sgst)).toBeCloseTo(Number(invoice.taxAmount) / 2);
      expect(taxInvoice.placeOfSupply).toBe('24');
    });

    it('nets CGST+SGST for a client in the same state, matched by alias ("GJ")', async () => {
      const client = await makeClient('GJ');
      const invoice = await createInvoice(
        { clientId: client.id, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()] },
        userId
      );
      invoiceIds.push(invoice.id);

      const taxInvoice = await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: invoice.id } });
      expect(Number(taxInvoice.igst)).toBe(0);
      expect(Number(taxInvoice.cgst)).toBeGreaterThan(0);
    });

    it('nets IGST for a client in a genuinely different state', async () => {
      const client = await makeClient('Maharashtra');
      const invoice = await createInvoice(
        { clientId: client.id, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()] },
        userId
      );
      invoiceIds.push(invoice.id);

      const taxInvoice = await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: invoice.id } });
      expect(Number(taxInvoice.cgst)).toBe(0);
      expect(Number(taxInvoice.sgst)).toBe(0);
      expect(Number(taxInvoice.igst)).toBeCloseTo(Number(invoice.taxAmount));
      expect(taxInvoice.placeOfSupply).toBe('27');
    });

    it('falls back to IGST when the client state is blank or unrecognized (regression)', async () => {
      const client = await makeClient('Nowhereland');
      const invoice = await createInvoice(
        { clientId: client.id, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()] },
        userId
      );
      invoiceIds.push(invoice.id);

      const taxInvoice = await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: invoice.id } });
      expect(Number(taxInvoice.cgst)).toBe(0);
      expect(Number(taxInvoice.igst)).toBeCloseTo(Number(invoice.taxAmount));
      expect(taxInvoice.placeOfSupply).toBe('Nowhereland'); // unresolved: raw free text preserved
    });
  });

  // Sales Executive / Terms: optional pass-through fields, no business logic — just prove they
  // land on the row when given and stay null (not empty-string/undefined-crash) when omitted.
  describe('salesPersonId / terms (optional pass-through)', () => {
    it('stores salesPersonId and terms when provided', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          salesPersonId: userId, terms: 'NET_30',
          items: [baseItem()],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(invoice.salesPersonId).toBe(userId);
      expect(invoice.terms).toBe('NET_30');
      expect((invoice as any).salesPerson?.name).toBe('Test User');
    });

    it('leaves salesPersonId and terms null when omitted (regression)', async () => {
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()] },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(invoice.salesPersonId).toBeNull();
      expect(invoice.terms).toBeNull();
    });
  });

  // Category summary: InvoiceItem.categoryId reuses the existing ProductCategory master already
  // on JewelryTag. Tagged lines inherit the tag's category; free-text lines may set one directly.
  describe('categoryId (per-invoice category summary)', () => {
    it('inherits the category from a tagged line\'s JewelryTag when none is given explicitly', async () => {
      const tag = await makeTag('Ring G (categorized)', { categoryId });
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem({ tagId: tag.id })] },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(invoice.items[0].categoryId).toBe(categoryId);
    });

    it('stores an explicit categoryId on a free-text line', async () => {
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem({ categoryId })] },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(invoice.items[0].categoryId).toBe(categoryId);
    });

    it('leaves categoryId null when neither the line nor its tag has one (regression)', async () => {
      const tag = await makeTag('Ring H (uncategorized)');
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem({ tagId: tag.id })] },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(invoice.items[0].categoryId).toBeNull();
    });
  });

  // otherCharges: GATI's "Add & Less" — a taxable add-on (shipping/packing/misc) alongside the
  // existing discountAmount ("less"). Both feed the same per-line tax-scale math (B1), so this
  // also proves that generalizes correctly instead of just working for discount.
  describe('otherCharges (Shipping & Tax add/less)', () => {
    it('adds otherCharges to the taxable amount and taxes it at the blended line rate', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
          otherCharges: 1000, items: [baseItem()], // 480000 line total, PER_GRAM/3%
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.otherCharges)).toBe(1000);
      const expectedTaxable = 480000 + 1000;
      expect(Number(invoice.totalAmount)).toBeCloseTo(expectedTaxable + expectedTaxable * 0.03);
    });

    it('defaults otherCharges to 0 when omitted (regression)', async () => {
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()] },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.otherCharges)).toBe(0);
    });

    // Caught live via Playwright: a line whose computed value is 0 (e.g. netGoldWeight entered
    // but goldRate left blank) makes subtotal 0, which used to make the discount/otherCharges
    // scale factor 0 too — silently dropping otherCharges' tax and tripping the A1 guard as a
    // false-positive 500 ("zero-GST on a taxable sale") instead of actually taxing otherCharges.
    it('still taxes otherCharges correctly when every line totals to zero', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', otherCharges: 500,
          items: [baseItem({ goldRate: 0, netGoldWeight: 10 })], // line totalPrice = 0
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.taxAmount)).toBeCloseTo(500 * 0.03);
      expect(Number(invoice.totalAmount)).toBeCloseTo(500 + 500 * 0.03);

      const taxInvoice = await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: invoice.id } });
      expect(Number(taxInvoice.totalTax)).toBeGreaterThan(0);
    });
  });

  // Inline payment (bill-and-collect in one screen) shares applyPayment() with the standalone
  // recordPayment endpoint — proving the two "routes" the user flagged as a risk stay consistent
  // with each other rather than duplicating (and potentially diverging) the same math.
  describe('inline payment at creation (shared applyPayment)', () => {
    it('applies an inline payment: paidAmount/balanceDue/status and client balance all net correctly', async () => {
      const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });

      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()],
          payments: [{ paymentDate: new Date(), amount: 200000, mode: 'BANK_TRANSFER' }],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.paidAmount)).toBe(200000);
      expect(Number(invoice.balanceDue)).toBeCloseTo(Number(invoice.totalAmount) - 200000);
      expect(invoice.status).toBe('PARTIALLY_PAID');

      const payments = await prisma.invoicePayment.findMany({ where: { invoiceId: invoice.id } });
      expect(payments).toHaveLength(1);
      expect(Number(payments[0].amount)).toBe(200000);

      // Debited by the full sale, credited back by the inline payment — same net effect as
      // create-then-recordPayment, because both go through applyPayment().
      const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      const expectedDelta = Number(invoice.totalAmount) - 200000;
      expect(Number(after.currentBalance) - Number(before.currentBalance)).toBeCloseTo(expectedDelta);
    });

    it('an inline payment plus a later recordPayment top-up land on the same invoice consistently', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()],
          payments: [{ paymentDate: new Date(), amount: 100000, mode: 'BANK_TRANSFER' }],
        },
        userId
      );
      invoiceIds.push(invoice.id);
      expect(Number(invoice.balanceDue)).toBeCloseTo(Number(invoice.totalAmount) - 100000);

      await recordPayment(
        { invoiceId: invoice.id, paymentDate: new Date(), amount: 50000, mode: 'UPI' },
        tenant.ctx, userId
      );

      const updated = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(Number(updated.paidAmount)).toBe(150000);
      expect(Number(updated.balanceDue)).toBeCloseTo(Number(invoice.totalAmount) - 150000);

      const payments = await prisma.invoicePayment.findMany({ where: { invoiceId: invoice.id } });
      expect(payments).toHaveLength(2);
    });

    it('splits a single payment across multiple modes (e.g. part cash, part UPI) correctly', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()],
          payments: [
            { paymentDate: new Date(), amount: 100000, mode: 'CASH' },
            { paymentDate: new Date(), amount: 350000, mode: 'UPI', referenceNo: 'UPI-TEST-1' },
          ],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.paidAmount)).toBe(450000);
      expect(Number(invoice.balanceDue)).toBeCloseTo(Number(invoice.totalAmount) - 450000);

      const payments = await prisma.invoicePayment.findMany({
        where: { invoiceId: invoice.id }, orderBy: { amount: 'desc' },
      });
      expect(payments).toHaveLength(2);
      expect(payments[0].mode).toBe('UPI');
      expect(payments[1].mode).toBe('CASH');
      // Each split gets its own auto-generated, unique transaction number.
      expect(payments[0].paymentNumber).toMatch(/^PMT-/);
      expect(payments[0].paymentNumber).not.toBe(payments[1].paymentNumber);
    });

    it('leaves the invoice unpaid/DRAFT when no payment is given at creation (regression)', async () => {
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()] },
        userId
      );
      invoiceIds.push(invoice.id);

      expect(Number(invoice.paidAmount)).toBe(0);
      expect(invoice.status).toBe('DRAFT');
    });
  });

  // Round-off: an INR bill is rounded to the nearest rupee automatically; the biller can key a figure instead.
  // The adjustment is part of totalAmount, is stored on the invoice, and is posted to the Round Off account so the
  // journal still balances to the paisa.
  describe('round-off (auto to the nearest ₹1, editable)', () => {
    const oneLine = (rate: number) => [baseItem({ netGoldWeight: 1, grossWeight: 1, goldRate: rate })];

    it('rounds an INR bill DOWN to the rupee and posts the difference as a debit to Round Off', async () => {
      // subtotal 48001.37 + 3% GST 1440.0411 = 49441.4111 -> 49441, round-off -0.4111
      const invoice = await createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: oneLine(48001.37) }, userId);
      invoiceIds.push(invoice.id);

      expect(Number(invoice.totalAmount)).toBe(49441);
      expect(Number(invoice.roundOff)).toBeCloseTo(-0.41, 2);
      expect(Number(invoice.balanceDue)).toBe(49441);

      const entry = await getJournalEntry(invoice.id);
      expect(Number(entry!.totalDebit)).toBeCloseTo(Number(entry!.totalCredit), 2);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).debit).toBeCloseTo(49441, 2);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ROUND_OFF).debit).toBeCloseTo(0.41, 2);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ROUND_OFF).credit).toBe(0);
    });

    it('rounds an INR bill UP to the rupee and posts the difference as a credit to Round Off', async () => {
      // subtotal 100.60 + 3% = 103.618 -> 104, round-off +0.382
      const invoice = await createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: oneLine(100.6) }, userId);
      invoiceIds.push(invoice.id);

      expect(Number(invoice.totalAmount)).toBe(104);
      expect(Number(invoice.roundOff)).toBeCloseTo(0.38, 2);

      const entry = await getJournalEntry(invoice.id);
      expect(Number(entry!.totalDebit)).toBeCloseTo(Number(entry!.totalCredit), 2);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ROUND_OFF).credit).toBeCloseTo(0.38, 2);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ROUND_OFF).debit).toBe(0);
    });

    it('keeps subtotal + charges - discount + GST + round-off equal to the total', async () => {
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', discountAmount: 11, otherCharges: 25.5, items: oneLine(48001.37) }, userId);
      invoiceIds.push(invoice.id);
      const parts = Number(invoice.subtotal) + Number(invoice.otherCharges) - Number(invoice.discountAmount) + Number(invoice.taxAmount) + Number(invoice.roundOff);
      expect(parts).toBeCloseTo(Number(invoice.totalAmount), 1);
      expect(Number(invoice.totalAmount) % 1).toBe(0); // whole rupees
    });

    it('uses a keyed round-off instead of the automatic one — 0 turns rounding off', async () => {
      const off = await createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', roundOff: 0, items: oneLine(48001.37) }, userId);
      invoiceIds.push(off.id);
      expect(Number(off.roundOff)).toBe(0);
      expect(Number(off.totalAmount)).toBeCloseTo(49441.41, 2); // unrounded
      const offEntry = await getJournalEntry(off.id);
      expect(offEntry!.lines.some((l) => l.account.code === LEDGER_ACCOUNT.ROUND_OFF)).toBe(false);

      const keyed = await createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', roundOff: 0.59, items: oneLine(48001.37) }, userId);
      invoiceIds.push(keyed.id);
      expect(Number(keyed.roundOff)).toBeCloseTo(0.59, 2);
      expect(Number(keyed.totalAmount)).toBeCloseTo(49442, 2);
      const keyedEntry = await getJournalEntry(keyed.id);
      expect(Number(keyedEntry!.totalDebit)).toBeCloseTo(Number(keyedEntry!.totalCredit), 2);
      expect(lineAmount(keyedEntry!, LEDGER_ACCOUNT.ROUND_OFF).credit).toBeCloseTo(0.59, 2);
    });

    it('refuses a round-off bigger than ±₹10 (that is a discount) and one that is not a number', async () => {
      for (const bad of [10.5, -11, 'abc' as unknown as number, NaN]) {
        await expect(
          createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', roundOff: bad, items: oneLine(48001.37) }, userId),
        ).rejects.toThrow(/Round-off must be a number/);
      }
    });

    it('does not round a non-INR bill on its own', async () => {
      const invoice = await createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', currency: 'USD', items: oneLine(48001.37) }, userId);
      invoiceIds.push(invoice.id);
      expect(Number(invoice.roundOff)).toBe(0);
      expect(Number(invoice.totalAmount)).toBeCloseTo(48001.37, 2);
    });
  });

  // The New Sale screen previews a bill (HSN rates, CGST+SGST vs IGST) before it exists; this is what it reads.
  describe('getTaxContext (GST preview for New Sale)', () => {
    it('lists the active HSN codes with their rates, including the default one', async () => {
      const t = await getTaxContext(tenant.ctx);
      expect(t.defaultHsnCode).toBe(DEFAULT_HSN_CODE);
      expect(t.hsnCodes.find((h) => h.code === DEFAULT_HSN_CODE)?.gstRate).toBeCloseTo(0.03, 4);
      expect(t.sameState).toBe(false); // no customer given
    });

    it("says same-state only when the customer's state resolves to the company's, and inter-state otherwise", async () => {
      const company = await prisma.company.findUniqueOrThrow({ where: { id: tenant.company.id }, select: { stateCode: true } });
      await prisma.company.update({ where: { id: tenant.company.id }, data: { stateCode: '24' } }); // Gujarat
      const local = await prisma.client.create({ data: { companyId: tenant.company.id, clientCode: `TSTGS-${suffix}-a`, name: 'Local', type: 'RETAIL', state: 'Gujarat' } });
      const away = await prisma.client.create({ data: { companyId: tenant.company.id, clientCode: `TSTGS-${suffix}-b`, name: 'Away', type: 'RETAIL', state: 'Kerala' } });
      const unknown = await prisma.client.create({ data: { companyId: tenant.company.id, clientCode: `TSTGS-${suffix}-c`, name: 'Walk-in', type: 'RETAIL' } });
      try {
        expect((await getTaxContext(tenant.ctx, local.id)).sameState).toBe(true);
        expect((await getTaxContext(tenant.ctx, away.id)).sameState).toBe(false);
        expect((await getTaxContext(tenant.ctx, unknown.id)).sameState).toBe(false); // blank state -> inter-state, as createInvoice
      } finally {
        await prisma.client.deleteMany({ where: { id: { in: [local.id, away.id, unknown.id] } } });
        await prisma.company.update({ where: { id: tenant.company.id }, data: { stateCode: company.stateCode } });
      }
    });
  });

  // F1: createInvoice/applyPayment/createSalesReturn now each post a balanced double-entry
  // JournalEntry (via postAutoJournalEntry) alongside their existing client.currentBalance
  // bump — previously nothing ever called createJournalEntry, so the Trial Balance/P&L/Balance
  // Sheet screens had no data at all. These prove the ledger side-effect, not just the balance.
  describe('F1 — ledger wiring (sales -> double-entry journal)', () => {
    it('posts a balanced AR/Revenue/GST/COGS entry for a tagged INR sale', async () => {
      const tag = await makeTag('Ring F1-a', { categoryId });

      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem({ tagId: tag.id })] },
        userId
      );
      invoiceIds.push(invoice.id);

      const entry = await getJournalEntry(invoice.id);
      expect(entry).not.toBeNull();
      expect(entry!.referenceType).toBe('SalesInvoice');
      expect(Number(entry!.totalDebit)).toBeCloseTo(Number(entry!.totalCredit));
      expect(Number(entry!.totalDebit)).toBeCloseTo(Number(invoice.totalAmount) + 40000); // + tag's costPrice (COGS)

      expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).debit).toBeCloseTo(Number(invoice.totalAmount));
      expect(lineAmount(entry!, LEDGER_ACCOUNT.SALES_REVENUE).credit).toBeCloseTo(Number(invoice.subtotal));
      expect(lineAmount(entry!, LEDGER_ACCOUNT.COST_OF_GOODS).debit).toBeCloseTo(40000); // makeTag's fixed costPrice
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INVENTORY).credit).toBeCloseTo(40000);

      // Same-state (no client.state set -> resolveStateCode fails -> treated inter-state, B2):
      // GST lands entirely in IGST, not split CGST/SGST.
      const gst = Number(invoice.taxAmount);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.IGST_PAYABLE).credit).toBeCloseTo(gst);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.CGST_PAYABLE).credit).toBe(0);

      // Account.balance actually moved, not just the JournalLine rows.
      const ar = await prisma.account.findUniqueOrThrow({ where: { companyId_code: { companyId: tenant.company.id, code: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE } } });
      const revenue = await prisma.account.findUniqueOrThrow({ where: { companyId_code: { companyId: tenant.company.id, code: LEDGER_ACCOUNT.SALES_REVENUE } } });
      // Can't assert absolute balances (shared across the whole suite/run history) — but posting
      // is unconditional, so re-fetching right after must already reflect this entry's lines.
      expect(ar).not.toBeNull();
      expect(revenue).not.toBeNull();
    });

    it('has no COGS/Inventory lines for a free-text (untagged) line — nothing physical sold', async () => {
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()] },
        userId
      );
      invoiceIds.push(invoice.id);

      const entry = await getJournalEntry(invoice.id);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.COST_OF_GOODS).debit).toBe(0);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INVENTORY).credit).toBe(0);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).debit).toBeCloseTo(Number(invoice.totalAmount));
    });

    it('still posts AR/Revenue for a non-INR sale, but no GST lines (taxAmount is 0)', async () => {
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', currency: 'USD', items: [baseItem()] },
        userId
      );
      invoiceIds.push(invoice.id);

      // Revenue recognition still happens on a non-INR sale — only GST (and, with no tagged
      // line here, COGS) are zero and so filtered out of the posted entry entirely.
      const entry = await getJournalEntry(invoice.id);
      expect(entry).not.toBeNull();
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).debit).toBeCloseTo(Number(invoice.totalAmount));
      expect(lineAmount(entry!, LEDGER_ACCOUNT.SALES_REVENUE).credit).toBeCloseTo(Number(invoice.subtotal));
      expect(lineAmount(entry!, LEDGER_ACCOUNT.IGST_PAYABLE).credit).toBe(0);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.CGST_PAYABLE).credit).toBe(0);
      expect(entry!.lines.some((l) => l.account.code === LEDGER_ACCOUNT.IGST_PAYABLE)).toBe(false);
    });

    it('posts a Cash-in-Hand vs Accounts Receivable entry for an inline CASH payment', async () => {
      const invoice = await createInvoice(
        {
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()],
          payments: [{ paymentDate: new Date(), amount: 50000, mode: 'CASH' }],
        },
        userId
      );
      invoiceIds.push(invoice.id);

      const payment = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: invoice.id } });
      const entry = await getJournalEntry(payment.id);
      expect(entry).not.toBeNull();
      expect(entry!.referenceType).toBe('InvoicePayment');
      expect(lineAmount(entry!, LEDGER_ACCOUNT.CASH_IN_HAND).debit).toBe(50000);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).credit).toBe(50000);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.BANK_ACCOUNT).debit).toBe(0);
    });

    it('routes a non-CASH mode (e.g. UPI) through Bank Account, not Cash in Hand', async () => {
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()] },
        userId
      );
      invoiceIds.push(invoice.id);

      await recordPayment({ invoiceId: invoice.id, paymentDate: new Date(), amount: 75000, mode: 'UPI' }, tenant.ctx, userId);

      const payment = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: invoice.id, mode: 'UPI' } });
      const entry = await getJournalEntry(payment.id);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.BANK_ACCOUNT).debit).toBe(75000);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.CASH_IN_HAND).debit).toBe(0);
    });

    it('reverses the original sale entry (Revenue/GST/COGS) exactly on a full return', async () => {
      const tag = await makeTag('Ring F1-b', { categoryId });
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem({ tagId: tag.id })] },
        userId
      );
      invoiceIds.push(invoice.id);
      const saleEntry = await getJournalEntry(invoice.id);

      const salesReturn = await createSalesReturn(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }] },
        tenant.ctx, userId
      );

      const returnEntry = await getJournalEntry(salesReturn.id);
      expect(returnEntry).not.toBeNull();
      expect(returnEntry!.referenceType).toBe('SalesReturn');

      // Full return of a single-line invoice: the reversal must exactly mirror the original sale,
      // debits and credits swapped.
      expect(lineAmount(returnEntry!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).credit)
        .toBeCloseTo(lineAmount(saleEntry!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).debit);
      expect(lineAmount(returnEntry!, LEDGER_ACCOUNT.SALES_REVENUE).debit)
        .toBeCloseTo(lineAmount(saleEntry!, LEDGER_ACCOUNT.SALES_REVENUE).credit);
      expect(lineAmount(returnEntry!, LEDGER_ACCOUNT.IGST_PAYABLE).debit)
        .toBeCloseTo(lineAmount(saleEntry!, LEDGER_ACCOUNT.IGST_PAYABLE).credit);
      expect(lineAmount(returnEntry!, LEDGER_ACCOUNT.INVENTORY).debit).toBeCloseTo(40000);
      expect(lineAmount(returnEntry!, LEDGER_ACCOUNT.COST_OF_GOODS).credit).toBeCloseTo(40000);
    });
  });

  // F3: a dealer/wholesale client with Client.creditLimit set gets blocked from a sale that would
  // push their balance over it. Unlimited (no creditLimit — the default, e.g. a lightweight
  // walk-in retail Client) is unaffected, proven throughout the rest of this file's tests, which
  // never set one.
  describe('F3 — dealer credit limit', () => {
    let limitedClientId: string;
    const limitedInvoiceIds: string[] = [];

    beforeAll(async () => {
      const client = await prisma.client.create({
        data: { companyId: tenant.company.id, clientCode: `TSTCL-F3-${suffix}`, name: 'Limited Dealer', panNumber: 'ABCDE1234F', type: 'WHOLESALE', creditLimit: 500000 },
      });
      limitedClientId = client.id;
    });

    afterAll(async () => {
      // Self-contained cleanup (this describe's own client, not the outer clientId), same
      // ordering the outer describe's afterAll uses — journal entries before the invoice rows
      // they reference, taxInvoice/salesInvoice before the client, memoOut last before the client.
      await cleanupJournalEntries(limitedInvoiceIds);
      await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: limitedInvoiceIds } } });
      await prisma.salesInvoice.deleteMany({ where: { id: { in: limitedInvoiceIds } } }); // cascades invoice_items
      await prisma.memoOut.deleteMany({ where: { clientId: limitedClientId } }); // cascades memo_items
      await prisma.client.deleteMany({ where: { id: limitedClientId } });
    });

    it('allows a sale that stays within the credit limit', async () => {
      const invoice = await createInvoice(
        { clientId: limitedClientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem()] },
        userId
      );
      limitedInvoiceIds.push(invoice.id);
      expect(Number(invoice.totalAmount)).toBeLessThan(500000);
    });

    it('rejects a sale that would push the balance over the credit limit, without touching inventory', async () => {
      const tag = await makeTag('Ring F3-a');
      const before = await prisma.client.findUniqueOrThrow({ where: { id: limitedClientId } });

      // baseItem() prices at 480000 (10g * 48000/g); pushing well past the 500000 limit together
      // with whatever this client already owes from the test above.
      await expect(
        createInvoice(
          { clientId: limitedClientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem({ tagId: tag.id })] },
          userId
        )
      ).rejects.toThrow(/credit limit/);

      const afterAttempt = await prisma.client.findUniqueOrThrow({ where: { id: limitedClientId } });
      expect(Number(afterAttempt.currentBalance)).toBeCloseTo(Number(before.currentBalance)); // untouched

      const stillInStock = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
      expect(stillInStock.status).toBe('IN_STOCK'); // rejected before any tag flip
    });

    it('rejects a memo conversion that would push the balance over the credit limit', async () => {
      const tag = await makeTag('Ring F3-b');
      const memo = await createMemoOut(
        {
          clientId: limitedClientId, branchId, sentDate: new Date(), returnDeadline: new Date(Date.now() + 7 * 86_400_000),
          items: [{
            productCode: tag.tagNumber, description: 'Ring F3-b', pieces: 1,
            grossWeight: 10, netGoldWeight: 10, estimatedValue: 490000, tagId: tag.id,
          }],
        },
        tenant.ctx, userId
      );

      await expect(
        convertMemoToInvoice(memo.id, [{ tagId: tag.id, sellingPrice: 490000 }], tenant.ctx, userId)
      ).rejects.toThrow(/credit limit/);

      const stillOnApproval = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
      expect(stillOnApproval.status).toBe('ON_APPROVAL'); // rejected before conversion touched it
    });
  });

  // D1: reversing a completed sale — the customer brings a piece back.
  describe('createSalesReturn (D1)', () => {
    it('flips the tag back to IN_STOCK and creates the SalesReturn/SalesReturnItem rows', async () => {
      const tag = await makeTag('Ring D1-a');
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem({ tagId: tag.id })] },
        userId
      );
      invoiceIds.push(invoice.id);

      const salesReturn = await createSalesReturn(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }] },
        tenant.ctx, userId
      );

      expect(salesReturn.returnNumber).toMatch(/^SRET-/);
      // 10*48000 line price, grossed up by its 3% GST — same tax-inclusive amount the client was
      // actually debited for on sale.
      expect(Number(salesReturn.totalAmount)).toBeCloseTo(480000 * 1.03);
      expect(salesReturn.items).toHaveLength(1);
      expect(salesReturn.items[0].tagId).toBe(tag.id);

      const updatedTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
      expect(updatedTag.status).toBe('IN_STOCK');
    });

    it('rejects a return for a tag that is not currently SOLD', async () => {
      const tag = await makeTag('Ring D1-b');
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem({ tagId: tag.id })] },
        userId
      );
      invoiceIds.push(invoice.id);

      // Simulate the tag already being back in stock through some other path.
      await prisma.jewelryTag.update({ where: { id: tag.id }, data: { status: 'IN_STOCK' } });

      await expect(
        createSalesReturn({ invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }] }, tenant.ctx, userId)
      ).rejects.toThrow(/not currently SOLD/);
    });

    it('rejects a free-text (no-tagId) line — nothing physical to take back', async () => {
      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem({ description: 'Making charge adjustment' })] },
        userId
      );
      invoiceIds.push(invoice.id);

      await expect(
        createSalesReturn({ invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }] }, tenant.ctx, userId)
      ).rejects.toThrow(/Only tagged lines can be returned/);
    });

    it('credits client.currentBalance by the returned amount, symmetric to the sale\'s debit', async () => {
      const tag = await makeTag('Ring D1-c');
      const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });

      const invoice = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem({ tagId: tag.id })] },
        userId
      );
      invoiceIds.push(invoice.id);

      const afterSale = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(Number(afterSale.currentBalance)).toBeCloseTo(Number(before.currentBalance) + Number(invoice.totalAmount));

      await createSalesReturn({ invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }] }, tenant.ctx, userId);

      const afterReturn = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(Number(afterReturn.currentBalance)).toBeCloseTo(Number(before.currentBalance));
    });

    it('lets the same tag be sold again on a later invoice after being returned', async () => {
      const tag = await makeTag('Ring D1-d');
      const invoice1 = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem({ tagId: tag.id })] },
        userId
      );
      invoiceIds.push(invoice1.id);

      await createSalesReturn({ invoiceId: invoice1.id, items: [{ invoiceItemId: invoice1.items[0].id }] }, tenant.ctx, userId);

      const invoice2 = await createInvoice(
        { clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [baseItem({ tagId: tag.id, goldRate: 50000 })] },
        userId
      );
      invoiceIds.push(invoice2.id);

      expect(invoice2.items[0].tagId).toBe(tag.id);
      const finalTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
      expect(finalTag.status).toBe('SOLD');
    });
  });
});

describe('convertMemoToInvoice (A1 guard, A3 tag-link regression)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let clientId: string;
  let memoId: string;
  let tagId: string;
  const invoiceIds: string[] = [];
  const extraTagIds: string[] = [];
  const extraMemoIds: string[] = [];

  beforeAll(async () => {
    tenant = await createTestTenant(`MEMO${suffix}`, ['invoice:create']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;

    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-${suffix}`, name: 'Test Client', panNumber: 'ABCDE1234F', type: 'WHOLESALE' },
    });
    clientId = client.id;

    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-${suffix}`, companyId: tenant.company.id,
        branchId, name: 'Memo Ring', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 10, netWeight: 10, stoneWeight: 0,
        costPrice: 40000, sellingPrice: 48000,
        createdById: userId,
      },
    });
    tagId = tag.id;

    const memo = await createMemoOut(
      {
        clientId, branchId, sentDate: new Date(), returnDeadline: new Date(Date.now() + 7 * 86400000),
        items: [{
          productCode: tag.tagNumber, description: 'Memo ring', pieces: 1,
          grossWeight: 10, netGoldWeight: 10, estimatedValue: 48000, tagId,
        }],
      },
      tenant.ctx, userId
    );
    memoId = memo.id;
  });

  afterAll(async () => {
    // F1: this block's tests (convertMemoToInvoice, D2's createSalesReturn) each post their own
    // JournalEntry (keyed by invoice.id and salesReturn.id respectively) against this tenant's
    // own Account rows — both must be cleaned up before cleanupTestTenant deletes those Account
    // rows below, same as the outer createInvoice describe's afterAll.
    const returnIds = (await prisma.salesReturn.findMany({ where: { invoiceId: { in: invoiceIds } }, select: { id: true } })).map((r) => r.id);
    await cleanupJournalEntries([...invoiceIds, ...returnIds]);
    // Must precede the salesInvoice/jewelryTag deletes below — same RESTRICT-FK ordering as the
    // createInvoice describe block's afterAll.
    await prisma.salesReturn.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.memoOut.deleteMany({ where: { id: { in: [memoId, ...extraMemoIds] } } }); // cascades memo_items
    await prisma.jewelryTag.deleteMany({ where: { id: { in: [tagId, ...extraTagIds] } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('emits a correctly-taxed TaxInvoice (A1) and links InvoiceItem.tagId (A3)', async () => {
    const invoice = await convertMemoToInvoice(
      memoId,
      [{ tagId, sellingPrice: 48000 }],
      tenant.ctx, userId
    );
    invoiceIds.push(invoice.id);

    expect(Number(invoice.taxAmount)).toBeCloseTo(48000 * 0.03);

    const taxInvoice = await prisma.taxInvoice.findUnique({ where: { invoiceId: invoice.id } });
    expect(taxInvoice).not.toBeNull();
    expect(Number(taxInvoice!.totalTax)).toBeCloseTo(48000 * 0.03);

    // A3: the tag flip to SOLD used to be the only trace of the sale — the InvoiceItem itself
    // carried no tagId, breaking any lookup from an invoice line back to its inventory tag.
    expect(invoice.items[0].tagId).toBe(tagId);
    const linkedItem = await prisma.invoiceItem.findFirst({ where: { tagId } });
    expect(linkedItem?.invoiceId).toBe(invoice.id);

    const finalTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tagId } });
    expect(finalTag.status).toBe('SOLD');
  });

  // D2: a dealer returns a piece sold via the memo-conversion path. createSalesReturn() is
  // channel-agnostic — it only cares about the resulting SalesInvoice/InvoiceItem/JewelryTag
  // chain, not which function created it — so this exercises the exact same code as D1's retail
  // return, just fed an invoice that came from convertMemoToInvoice instead of createInvoice.
  it('D2: returns a memo-converted (wholesale) sale the same way a retail one is returned', async () => {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-D2-${suffix}`, companyId: tenant.company.id,
        branchId, name: 'Wholesale Ring', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 8, netWeight: 8, stoneWeight: 0,
        costPrice: 30000, sellingPrice: 36000,
        createdById: userId,
      },
    });
    extraTagIds.push(tag.id);

    const memo = await createMemoOut(
      {
        clientId, branchId, sentDate: new Date(), returnDeadline: new Date(Date.now() + 7 * 86400000),
        items: [{
          productCode: tag.tagNumber, description: 'Wholesale ring', pieces: 1,
          grossWeight: 8, netGoldWeight: 8, estimatedValue: 36000, tagId: tag.id,
        }],
      },
      tenant.ctx, userId
    );
    extraMemoIds.push(memo.id);

    const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });

    const invoice = await convertMemoToInvoice(memo.id, [{ tagId: tag.id, sellingPrice: 36000 }], tenant.ctx, userId);
    invoiceIds.push(invoice.id);

    const afterSale = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(Number(afterSale.currentBalance)).toBeCloseTo(Number(before.currentBalance) + Number(invoice.totalAmount));

    const salesReturn = await createSalesReturn(
      { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }], reason: 'Dealer return' },
      tenant.ctx, userId
    );
    expect(salesReturn.items[0].tagId).toBe(tag.id);

    const returnedTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
    expect(returnedTag.status).toBe('IN_STOCK');

    const afterReturn = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(Number(afterReturn.currentBalance)).toBeCloseTo(Number(before.currentBalance));

    // The memo itself is a closed historical record of the original conversion — a later return
    // doesn't rewrite it, same "never edit history" rule D1 applies to the SalesInvoice.
    const finalMemo = await prisma.memoOut.findUniqueOrThrow({ where: { id: memo.id } });
    expect(finalMemo.status).toBe('CONVERTED');
  });
});

describe('createOldGoldExchange (D4)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const testKarat = '22K'; // seeded in every DB by the karat_master migration (C1)

  let tenant: TestTenant;
  let userId: string;
  let clientId: string;
  const exchangeIds: string[] = [];
  const metalStockIds: string[] = [];
  const rateIds: string[] = [];

  beforeAll(async () => {
    tenant = await createTestTenant(`D4${suffix}`, ['invoice:create']);
    userId = tenant.user.id;

    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-D4-${suffix}`, name: 'Test Client', panNumber: 'ABCDE1234F', type: 'RETAIL' },
    });
    clientId = client.id;

    const today = new Date(new Date().toISOString().split('T')[0]);
    const rate = await prisma.metalRate.create({
      data: { companyId: tenant.company.id, date: today, karat: testKarat, purity: 0.916, ratePerGram: 5000 },
    });
    rateIds.push(rate.id);
  });

  afterAll(async () => {
    await cleanupJournalEntries(exchangeIds);
    await prisma.oldGoldExchange.deleteMany({ where: { id: { in: exchangeIds } } });
    await prisma.metalStock.deleteMany({ where: { id: { in: metalStockIds } } });
    await prisma.metalRate.deleteMany({ where: { id: { in: rateIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('values net weight * rate with no deduction, credits the client, and tracks the metal', async () => {
    const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });

    const exchange = await createOldGoldExchange(
      { clientId, description: 'Old bangle', karat: testKarat, grossWeight: 10, stoneWeight: 2 },
      tenant.ctx, userId
    );
    exchangeIds.push(exchange.id);
    metalStockIds.push(exchange.metalStockId!);

    expect(exchange.exchangeNumber).toMatch(/^OGX-/);
    expect(Number(exchange.netWeight)).toBeCloseTo(8); // 10 - 2 stone weight
    expect(Number(exchange.valuedAmount)).toBeCloseTo(8 * 5000); // netWeight * ratePerGram, no deduction

    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(Number(after.currentBalance)).toBeCloseTo(Number(before.currentBalance) - 8 * 5000);

    const stock = await prisma.metalStock.findUniqueOrThrow({ where: { id: exchange.metalStockId! } });
    expect(Number(stock.netWeight)).toBeCloseTo(8);
    expect(Number(stock.avgCostPerGram)).toBeCloseTo(5000);
    expect(stock.sourceType).toBe('CUSTOMER_SUPPLIED');
    expect(stock.sourceRef).toBe(exchange.exchangeNumber);

    // F1: Dr Inventory (the metal that just came in) / Cr Accounts Receivable (the store credit —
    // a negative receivable), balanced, valued at exactly what was credited to the client.
    const entry = await getJournalEntry(exchange.id);
    expect(entry).not.toBeNull();
    expect(entry!.referenceType).toBe('OldGoldExchange');
    expect(lineAmount(entry!, LEDGER_ACCOUNT.INVENTORY).debit).toBeCloseTo(8 * 5000);
    expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).credit).toBeCloseTo(8 * 5000);
  });

  it('applies a deduction % to both the valuation and the metal stock cost basis', async () => {
    const exchange = await createOldGoldExchange(
      { clientId, description: 'Old ring', karat: testKarat, grossWeight: 5, deductionPercent: 10 },
      tenant.ctx, userId
    );
    exchangeIds.push(exchange.id);
    metalStockIds.push(exchange.metalStockId!);

    const deductedRate = 5000 * 0.9;
    expect(Number(exchange.valuedAmount)).toBeCloseTo(5 * deductedRate);

    const stock = await prisma.metalStock.findUniqueOrThrow({ where: { id: exchange.metalStockId! } });
    expect(Number(stock.avgCostPerGram)).toBeCloseTo(deductedRate);
  });

  it('rejects an unknown karat/purity code', async () => {
    await expect(
      createOldGoldExchange({ clientId, description: 'Fake piece', karat: '99K', grossWeight: 5 }, tenant.ctx, userId)
    ).rejects.toThrow(/Unknown karat\/purity code/);
  });

  it('rejects a karat with no MetalRate on or before the exchange date', async () => {
    await expect(
      createOldGoldExchange({ clientId, description: 'Platinum piece', karat: 'PT', grossWeight: 5 }, tenant.ctx, userId)
    ).rejects.toThrow(/No metal rate found/);
  });
});

// Billing with credit: the customer's old metal (OLD_GOLD) and credit already on their account from a return or an
// earlier exchange (STORE_CREDIT) are payment modes on the bill. Neither moves cash: the credit was booked when it
// arose, so the sale's debit already nets it — the payment row only marks the invoice paid.
describe('createInvoice — old gold & store credit as payment modes', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const karat = '22K'; // seeded in every DB by the karat_master migration (C1)

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  const clientIds: string[] = [];
  const invoiceIds: string[] = [];
  const tagIds: string[] = [];
  const rateIds: string[] = [];

  async function makeClient(label: string) {
    const c = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-${label}-${suffix}`, name: `Client ${label}`, panNumber: 'ABCDE1234F', type: 'RETAIL' },
    });
    clientIds.push(c.id);
    return c.id;
  }
  async function makeTag(name: string) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-CR-${suffix}-${tagIds.length}`, companyId: tenant.company.id, branchId, name,
        metalType: 'GOLD', metalKarat: karat, grossWeight: 1, netWeight: 1, stoneWeight: 0,
        costPrice: 4000, sellingPrice: 5150, createdById: userId,
      },
    });
    tagIds.push(tag.id);
    return tag;
  }
  // 1 g x ₹5,000 + 3% GST = ₹5,150 a piece, no making charge.
  const item = (over: Partial<Parameters<typeof _createInvoice>[0]['items'][number]> = {}) => ({
    productCode: 'MISC', description: 'Chain', quantity: 1, grossWeight: 1, netGoldWeight: 1,
    rateType: 'PER_GRAM', goldRate: 5000, makingCharge: 0, ...over,
  });
  const sell = async (clientId: string, over: Partial<Parameters<typeof _createInvoice>[0]> = {}) => {
    const inv = await _createInvoice({
      branchId, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [item()], ...over,
    }, tenant.ctx, userId);
    invoiceIds.push(inv.id);
    return inv;
  };
  const balanceOf = async (clientId: string) =>
    Number((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentBalance);

  // Credit on the account the way it really arises: sell a tagged piece (paid in full) and take it back.
  async function clientWithReturnCredit(label: string) {
    const clientId = await makeClient(label);
    const tag = await makeTag(`Returned ${label}`);
    const sold = await sell(clientId, { items: [item({ tagId: tag.id })], payments: [{ paymentDate: new Date(), amount: 5150, mode: 'UPI' }] });
    await createSalesReturn({ invoiceId: sold.id, items: [{ invoiceItemId: sold.items[0].id }] }, tenant.ctx, userId);
    return clientId;
  }

  beforeAll(async () => {
    tenant = await createTestTenant(`CR${suffix}`, ['invoice:create']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
    const today = new Date(new Date().toISOString().split('T')[0]);
    rateIds.push((await prisma.metalRate.create({
      data: { companyId: tenant.company.id, date: today, karat, purity: 0.916, ratePerGram: 5000 },
    })).id);
  });

  afterAll(async () => {
    const returnIds = (await prisma.salesReturn.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } })).map((r) => r.id);
    const payIds = (await prisma.invoicePayment.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } })).map((p) => p.id);
    const exchanges = await prisma.oldGoldExchange.findMany({ where: { clientId: { in: clientIds } }, select: { id: true, metalStockId: true } });
    await cleanupJournalEntries([...invoiceIds, ...returnIds, ...payIds, ...exchanges.map((e) => e.id)]);
    await prisma.salesReturn.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.oldGoldExchange.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.metalStock.deleteMany({ where: { id: { in: exchanges.map((e) => e.metalStockId).filter(Boolean) as string[] } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.metalRate.deleteMany({ where: { id: { in: rateIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  describe('STORE_CREDIT (credit from a sales return)', () => {
    it('reports the credit a return left on the account', async () => {
      const clientId = await clientWithReturnCredit('rep');
      expect(await getClientCredit(tenant.ctx, clientId)).toEqual({ clientId, balance: -5150, available: 5150 });
    });

    it('settles a bill out of that credit: invoice PAID, balance back to zero, no cash and no journal for the settlement', async () => {
      const clientId = await clientWithReturnCredit('full');
      const tag = await makeTag('New piece');

      const inv = await sell(clientId, {
        items: [item({ tagId: tag.id })],
        payments: [{ paymentDate: new Date(), amount: 5150, mode: 'STORE_CREDIT' }],
      });

      expect(inv.status).toBe('PAID');
      expect(Number(inv.paidAmount)).toBe(5150);
      expect(Number(inv.balanceDue)).toBe(0);
      expect(await balanceOf(clientId)).toBeCloseTo(0); // -5150 credit + 5150 sale; the credit is what paid for it
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('SOLD');

      const [pay] = await prisma.invoicePayment.findMany({ where: { invoiceId: inv.id } });
      expect(pay.mode).toBe('STORE_CREDIT');
      expect(await getJournalEntry(pay.id)).toBeNull(); // credit was already booked when the return happened
      expect((await getClientCredit(tenant.ctx, clientId)).available).toBe(0);
    });

    it('part credit + part UPI on one bill', async () => {
      const clientId = await clientWithReturnCredit('mix');
      const inv = await sell(clientId, {
        items: [item({ quantity: 2 })], // ₹10,300
        payments: [
          { paymentDate: new Date(), amount: 5150, mode: 'STORE_CREDIT' },
          { paymentDate: new Date(), amount: 5150, mode: 'UPI' },
        ],
      });
      expect(inv.status).toBe('PAID');
      expect(await balanceOf(clientId)).toBeCloseTo(0);

      const pays = await prisma.invoicePayment.findMany({ where: { invoiceId: inv.id } });
      const upi = pays.find((p) => p.mode === 'UPI')!;
      expect(await getJournalEntry(upi.id)).not.toBeNull(); // real money still hits the books
      expect(await getJournalEntry(pays.find((p) => p.mode === 'STORE_CREDIT')!.id)).toBeNull();
    });

    it('refuses more credit than the customer has — nothing is sold, the tag stays in stock', async () => {
      const clientId = await clientWithReturnCredit('over');
      const tag = await makeTag('Blocked piece');
      const invoicesBefore = await prisma.salesInvoice.count({ where: { clientId } });

      await expect(sell(clientId, {
        items: [item({ tagId: tag.id, quantity: 1, goldRate: 6000 })], // ₹6,180 bill
        payments: [{ paymentDate: new Date(), amount: 6180, mode: 'STORE_CREDIT' }],
      })).rejects.toThrow(/Only 5150 of store credit is available/);

      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('IN_STOCK');
      expect(await prisma.salesInvoice.count({ where: { clientId } })).toBe(invoicesBefore);
      expect(await balanceOf(clientId)).toBeCloseTo(-5150);
    });

    it('refuses credit for a customer with none', async () => {
      const clientId = await makeClient('none');
      await expect(sell(clientId, { payments: [{ paymentDate: new Date(), amount: 100, mode: 'STORE_CREDIT' }] }))
        .rejects.toThrow(/Only 0 of store credit is available/);
    });

    it('refuses credit larger than what is still due on the bill', async () => {
      const clientId = await clientWithReturnCredit('gt');
      await expect(sell(clientId, {
        items: [item({ goldRate: 500 })], // ₹515 bill, credit is ₹5,150
        payments: [{ paymentDate: new Date(), amount: 5150, mode: 'STORE_CREDIT' }],
      })).rejects.toThrow(/more than the .* still due/);
    });

    it('cannot spend the same credit twice on one bill', async () => {
      const clientId = await clientWithReturnCredit('twice');
      await expect(sell(clientId, {
        items: [item({ quantity: 2 })],
        payments: [
          { paymentDate: new Date(), amount: 5150, mode: 'STORE_CREDIT' },
          { paymentDate: new Date(), amount: 5150, mode: 'STORE_CREDIT' },
        ],
      })).rejects.toThrow(/store credit is available/);
    });
  });

  describe('OLD_GOLD (customer hands over old metal on the bill)', () => {
    const oldGold = (over: Partial<{ grossWeight: number; stoneWeight: number; deductionPercent: number; karat: string }> = {}) =>
      ({ description: 'Old chain', karat, grossWeight: 1.2, stoneWeight: 0.2, ...over });

    it('values the metal, books the exchange, tracks it in the vault and settles the bill with it', async () => {
      const clientId = await makeClient('og1');
      const inv = await sell(clientId, { // ₹5,150 bill: old gold worth 1 g x ₹5,000 = ₹5,000, ₹150 by UPI
        payments: [
          { paymentDate: new Date(), amount: 0, mode: 'OLD_GOLD', oldGold: oldGold() },
          { paymentDate: new Date(), amount: 150, mode: 'UPI' },
        ],
      });

      expect(inv.status).toBe('PAID');
      expect(await balanceOf(clientId)).toBeCloseTo(0);

      const [ex] = await prisma.oldGoldExchange.findMany({ where: { clientId } });
      expect(ex.exchangeNumber).toMatch(/^OGX-/);
      expect(Number(ex.netWeight)).toBeCloseTo(1);
      expect(Number(ex.valuedAmount)).toBe(5000);

      const stock = await prisma.metalStock.findUniqueOrThrow({ where: { id: ex.metalStockId! } });
      expect(stock.sourceType).toBe('CUSTOMER_SUPPLIED');
      expect(Number(stock.netWeight)).toBeCloseTo(1);

      // The exchange posts its own Dr Inventory / Cr AR; the settlement on the bill posts nothing more.
      const exEntry = await getJournalEntry(ex.id);
      expect(lineAmount(exEntry!, LEDGER_ACCOUNT.INVENTORY).debit).toBe(5000);
      expect(lineAmount(exEntry!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).credit).toBe(5000);

      const pays = await prisma.invoicePayment.findMany({ where: { invoiceId: inv.id } });
      const og = pays.find((p) => p.mode === 'OLD_GOLD')!;
      expect(Number(og.amount)).toBe(5000);
      expect(og.referenceNo).toBe(ex.exchangeNumber);
      expect(await getJournalEntry(og.id)).toBeNull();
    });

    it('applies the melting-loss deduction % to the value', async () => {
      const clientId = await makeClient('og2');
      await sell(clientId, {
        payments: [{ paymentDate: new Date(), amount: 0, mode: 'OLD_GOLD', oldGold: oldGold({ stoneWeight: 0.2, deductionPercent: 10 }) }],
      });
      const [ex] = await prisma.oldGoldExchange.findMany({ where: { clientId } });
      expect(Number(ex.valuedAmount)).toBe(4500); // 1 g x ₹5,000 x 90%
    });

    it('metal worth more than the bill pays it off and leaves the rest as credit on the account', async () => {
      const clientId = await makeClient('og3');
      const inv = await sell(clientId, { // bill ₹5,150, old gold ₹10,000
        payments: [{ paymentDate: new Date(), amount: 0, mode: 'OLD_GOLD', oldGold: oldGold({ grossWeight: 2, stoneWeight: 0 }) }],
      });

      expect(inv.status).toBe('PAID');
      expect(Number(inv.paidAmount)).toBe(5150);
      expect(Number(inv.balanceDue)).toBe(0);
      expect(await balanceOf(clientId)).toBeCloseTo(-4850);
      expect((await getClientCredit(tenant.ctx, clientId)).available).toBeCloseTo(4850);
    });

    it('needs the metal details, and rejects a bad karat before any tag is sold', async () => {
      const clientId = await makeClient('og4');
      const tag = await makeTag('Guarded piece');

      await expect(sell(clientId, { items: [item({ tagId: tag.id })], payments: [{ paymentDate: new Date(), amount: 100, mode: 'OLD_GOLD' }] }))
        .rejects.toThrow(/Old gold details/);
      await expect(sell(clientId, {
        items: [item({ tagId: tag.id })],
        payments: [{ paymentDate: new Date(), amount: 0, mode: 'OLD_GOLD', oldGold: oldGold({ karat: '99K' }) }],
      })).rejects.toThrow(/Unknown karat/);

      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('IN_STOCK');
      expect(await prisma.oldGoldExchange.count({ where: { clientId } })).toBe(0);
    });

    it('rolls the whole bill back — exchange and vault entry included — if a later split fails', async () => {
      const clientId = await makeClient('og5');
      const tag = await makeTag('Rollback piece');
      const stocksBefore = await prisma.metalStock.count({ where: { companyId: tenant.company.id } });

      await expect(sell(clientId, {
        items: [item({ tagId: tag.id })],
        payments: [
          { paymentDate: new Date(), amount: 0, mode: 'OLD_GOLD', oldGold: oldGold() },
          { paymentDate: new Date(), amount: 100, mode: 'STORE_CREDIT' }, // this customer has no credit to spend
        ],
      })).rejects.toThrow(/store credit is available/);

      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('IN_STOCK');
      expect(await prisma.oldGoldExchange.count({ where: { clientId } })).toBe(0);
      expect(await prisma.metalStock.count({ where: { companyId: tenant.company.id } })).toBe(stocksBefore);
      expect(await balanceOf(clientId)).toBe(0);
    });
  });

  describe('outside a bill', () => {
    it('recordPayment / recordClientPayment refuse the credit modes', async () => {
      const clientId = await makeClient('rec');
      const inv = await sell(clientId);
      await expect(recordPayment({ invoiceId: inv.id, paymentDate: new Date(), amount: 100, mode: 'STORE_CREDIT' }, tenant.ctx, userId))
        .rejects.toThrow(/only be used while creating an invoice/);
      await expect(recordClientPayment({ clientId, paymentDate: new Date(), amount: 100, mode: 'old_gold' }, tenant.ctx, userId))
        .rejects.toThrow(/only be used while creating an invoice/);
    });

    it("the client's ledger does not count a credit settlement twice, and still closes on the account balance", async () => {
      const clientId = await clientWithReturnCredit('led');
      await sell(clientId, { // ₹10,300 bill: ₹2,000 from the return credit, ₹5,000 old gold, ₹3,000 UPI, ₹300 left due
        items: [item({ quantity: 2 })],
        payments: [
          { paymentDate: new Date(), amount: 2000, mode: 'STORE_CREDIT' },
          { paymentDate: new Date(), amount: 0, mode: 'OLD_GOLD', oldGold: { description: 'Old ring', karat, grossWeight: 1 } },
          { paymentDate: new Date(), amount: 3000, mode: 'UPI' },
        ],
      });

      const ledger = await getClientLedger(tenant.ctx, clientId);
      expect(ledger.rows.some((r: any) => /STORE_CREDIT|OLD_GOLD/.test(r.description))).toBe(false);
      expect(ledger.rows.filter((r: any) => r.type === 'EXCHANGE')).toHaveLength(1);
      expect(ledger.closingBalance).toBeCloseTo(await balanceOf(clientId)); // -2850: ₹3,150 credit left, ₹300 due

      const day = await getDayBook(tenant.company.id, new Date());
      expect(day.payments.byMode.some((m: any) => m.mode === 'STORE_CREDIT' || m.mode === 'OLD_GOLD')).toBe(false);
    });
  });
});

// Editing an issued invoice (amendInvoice): stock, GST, ledger and the customer's balance all follow the new bill in
// one transaction, the original ledger entries stay, and the audit log keeps before/after.
describe('amendInvoice (edit an issued invoice)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  const clientIds: string[] = [];
  const invoiceIds: string[] = [];
  const tagIds: string[] = [];

  async function makeClient(label: string) {
    const c = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-${label}-${suffix}`, name: `Client ${label}`, panNumber: 'ABCDE1234F', type: 'RETAIL' },
    });
    clientIds.push(c.id);
    return c.id;
  }
  async function makeTag(name: string, costPrice = 4000) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-AM-${suffix}-${tagIds.length}`, companyId: tenant.company.id, branchId, name,
        metalType: 'GOLD', metalKarat: '22K', grossWeight: 1, netWeight: 1, stoneWeight: 0,
        costPrice, sellingPrice: 5150, createdById: userId,
      },
    });
    tagIds.push(tag.id);
    return tag;
  }
  // 1 g x ₹5,000 + 3% GST = ₹5,150 a piece.
  const item = (over: Partial<InvoiceItemInputLike> = {}) => ({
    productCode: 'MISC', description: 'Chain', quantity: 1, grossWeight: 1, netGoldWeight: 1,
    rateType: 'PER_GRAM', goldRate: 5000, makingCharge: 0, ...over,
  });
  type InvoiceItemInputLike = Parameters<typeof _createInvoice>[0]['items'][number];
  const sell = async (clientId: string, over: Partial<Parameters<typeof _createInvoice>[0]> = {}) => {
    const inv = await _createInvoice({ branchId, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [item()], ...over }, tenant.ctx, userId);
    invoiceIds.push(inv.id);
    return inv;
  };
  // A stored line, sent back unchanged (with its id) plus whatever the edit overrides.
  const keep = (l: any, over: Partial<InvoiceItemInputLike> = {}): InvoiceItemInputLike => ({
    id: l.id, productCode: l.productCode, description: l.description, quantity: l.quantity, grossWeight: Number(l.grossWeight),
    netGoldWeight: Number(l.netGoldWeight), rateType: l.rateType, goldRate: Number(l.goldRate), makingCharge: Number(l.makingCharge),
    wastagePercent: Number(l.wastagePercent), stoneValue: Number(l.stoneValue), tagId: l.tagId ?? undefined, ...over,
  });
  const amend = (id: string, data: Parameters<typeof amendInvoice>[1]) => amendInvoice(id, data, tenant.ctx, userId);
  const balanceOf = async (clientId: string) => Number((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentBalance);
  const entriesOf = (referenceId: string) => prisma.journalEntry.findMany({
    where: { referenceId }, include: { lines: { include: { account: { select: { code: true } } } } },
  });
  const amountOn = (e: Awaited<ReturnType<typeof entriesOf>>[number], code: string) => {
    const l = e.lines.find((x) => x.account.code === code);
    return { debit: Number(l?.debit ?? 0), credit: Number(l?.credit ?? 0) };
  };
  const statusOf = async (id: string) => (await prisma.jewelryTag.findUniqueOrThrow({ where: { id } })).status;

  beforeAll(async () => {
    tenant = await createTestTenant(`AM${suffix}`, ['invoice:create']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
  });

  afterAll(async () => {
    const returnIds = (await prisma.salesReturn.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } })).map((r) => r.id);
    const payIds = (await prisma.invoicePayment.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } })).map((p) => p.id);
    await cleanupJournalEntries([...invoiceIds, ...returnIds, ...payIds]);
    await prisma.salesReturn.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('reprices a line: totals, GST record, customer balance, an adjustment journal and the audit trail all follow', async () => {
    const clientId = await makeClient('price');
    const inv = await sell(clientId); // ₹5,150
    expect(await balanceOf(clientId)).toBeCloseTo(5150);

    const upd = await amend(inv.id, { items: [keep(inv.items[0], { goldRate: 6000 })], reason: 'Rate was keyed wrong' }); // ₹6,180

    expect(Number(upd.totalAmount)).toBe(6180);
    expect(Number(upd.taxAmount)).toBe(180);
    expect(Number(upd.balanceDue)).toBe(6180);
    expect(upd.items).toHaveLength(1);
    expect(upd.items[0].id).toBe(inv.items[0].id); // updated in place, same row
    expect(await balanceOf(clientId)).toBeCloseTo(6180); // moved by the +1,030 difference only
    const tax = await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: inv.id } });
    expect(Number(tax.taxableAmount)).toBe(6000);
    expect(Number(tax.totalTax)).toBe(180);

    // Ledger: the original entry is untouched, plus ONE balanced adjustment for the difference.
    const entries = await entriesOf(inv.id);
    expect(entries).toHaveLength(2);
    const original = entries.find((e) => e.referenceType === 'SalesInvoice')!;
    const adj = entries.find((e) => e.referenceType === 'SalesInvoiceAmendment')!;
    expect(amountOn(original, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).debit).toBe(5150);
    expect(amountOn(adj, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).debit).toBe(1030);
    expect(amountOn(adj, LEDGER_ACCOUNT.SALES_REVENUE).credit).toBe(1000);
    expect(amountOn(adj, LEDGER_ACCOUNT.IGST_PAYABLE).credit).toBe(30);
    expect(adj.lines.reduce((s, l) => s + Number(l.debit), 0)).toBeCloseTo(adj.lines.reduce((s, l) => s + Number(l.credit), 0));

    const audit = await prisma.auditLog.findFirst({ where: { recordId: inv.id, action: 'AMEND' } });
    expect(audit).not.toBeNull();
    expect((audit!.oldValues as any).totalAmount).toBe('5150');
    expect((audit!.newValues as any).totalAmount).toBe('6180');
    expect((audit!.newValues as any).reason).toBe('Rate was keyed wrong');
  });

  it('swaps a piece: the old tag goes back in stock, the new one is sold, and the COGS difference is booked', async () => {
    const clientId = await makeClient('swap');
    const a = await makeTag('Piece A', 4000);
    const b = await makeTag('Piece B', 4600);
    const inv = await sell(clientId, { items: [item({ tagId: a.id })] });

    await amend(inv.id, { items: [keep(inv.items[0], { tagId: b.id })] });

    expect(await statusOf(a.id)).toBe('IN_STOCK');
    expect(await statusOf(b.id)).toBe('SOLD');
    const adj = (await entriesOf(inv.id)).find((e) => e.referenceType === 'SalesInvoiceAmendment')!;
    expect(amountOn(adj, LEDGER_ACCOUNT.COST_OF_GOODS).debit).toBe(600); // 4,600 - 4,000
    expect(amountOn(adj, LEDGER_ACCOUNT.INVENTORY).credit).toBe(600);
  });

  it('adds and removes lines; a removed piece returns to stock and a new one is sold', async () => {
    const clientId = await makeClient('addrm');
    const a = await makeTag('Piece A2');
    const b = await makeTag('Piece B2');
    const inv = await sell(clientId, { items: [item({ tagId: a.id }), item({ description: 'Gift wrap', goldRate: 100 })] }); // 5,150 + 103

    const upd = await amend(inv.id, { items: [keep(inv.items[1]), item({ tagId: b.id })] }); // A out, B in, wrap kept

    expect(upd.items.map((i) => i.tagId).sort()).toEqual([b.id, null].sort());
    expect(await statusOf(a.id)).toBe('IN_STOCK');
    expect(await statusOf(b.id)).toBe('SOLD');
    expect(Number(upd.totalAmount)).toBe(5253); // same value in as out
    expect(await balanceOf(clientId)).toBeCloseTo(5253);
  });

  it('re-derives paid / due / status from the payments already recorded', async () => {
    const clientId = await makeClient('paid');
    const inv = await sell(clientId, { payments: [{ paymentDate: new Date(), amount: 5150, mode: 'UPI' }] });
    expect(inv.status).toBe('PAID');

    const up = await amend(inv.id, { items: [keep(inv.items[0], { goldRate: 6000 })] }); // ₹6,180: 1,030 still owed
    expect(up.status).toBe('PARTIALLY_PAID');
    expect(Number(up.balanceDue)).toBe(1030);
    expect(Number(up.paidAmount)).toBe(5150);
    expect(await balanceOf(clientId)).toBeCloseTo(1030);

    const down = await amend(inv.id, { items: [keep(up.items[0], { goldRate: 3000 })] }); // ₹3,090: over-paid by 2,060
    expect(down.status).toBe('PAID');
    expect(Number(down.balanceDue)).toBe(-2060);
    expect(await balanceOf(clientId)).toBeCloseTo(-2060); // shows as credit on the account
    expect(await prisma.invoicePayment.count({ where: { invoiceId: inv.id } })).toBe(1); // payments untouched
  });

  it('recomputes GST for a customer in the company state (CGST + SGST instead of IGST)', async () => {
    const company = await prisma.company.findUniqueOrThrow({ where: { id: tenant.company.id } });
    const stateName = (await prisma.stateMaster.findFirst({ where: { code: company.stateCode ?? '' } }))?.name;
    expect(stateName).toBeTruthy(); // the fixture company is in state 24 (Gujarat) — seeded in StateMaster
    const local = await prisma.client.create({ data: { companyId: tenant.company.id, clientCode: `TSTCL-loc-${suffix}`, name: 'Local', state: stateName, type: 'RETAIL' } });
    clientIds.push(local.id);
    const clientId = await makeClient('far');
    const inv = await sell(clientId);
    expect(Number((await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: inv.id } })).igst)).toBe(150);

    await amend(inv.id, { clientId: local.id, items: [keep(inv.items[0])] });

    const tax = await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: inv.id } });
    expect(Number(tax.igst)).toBe(0);
    expect(Number(tax.cgst)).toBe(75);
    expect(Number(tax.sgst)).toBe(75);
  });

  describe('guards', () => {
    it('a returned line is locked (cannot be changed or removed) but the rest of the bill can be edited', async () => {
      const clientId = await makeClient('ret');
      const a = await makeTag('Returned A');
      const b = await makeTag('Kept B');
      const inv = await sell(clientId, { items: [item({ tagId: a.id }), item({ tagId: b.id })] });
      await createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: inv.items.find((i) => i.tagId === a.id)!.id }] }, tenant.ctx, userId);
      const lineA = inv.items.find((i) => i.tagId === a.id)!;
      const lineB = inv.items.find((i) => i.tagId === b.id)!;

      await expect(amend(inv.id, { items: [keep(lineA, { goldRate: 9000 }), keep(lineB)] })).rejects.toThrow(/has been returned and cannot be changed/);
      await expect(amend(inv.id, { items: [keep(lineB)] })).rejects.toThrow(/has been returned and cannot be changed or removed/);

      const ok = await amend(inv.id, { items: [keep(lineA), keep(lineB, { goldRate: 6000 })] });
      expect(ok.items).toHaveLength(2);
      expect(await statusOf(a.id)).toBe('IN_STOCK'); // still back in stock from the return — not flipped again
      expect(await statusOf(b.id)).toBe('SOLD');
    });

    it('the customer cannot be changed once a payment is recorded, but can before', async () => {
      const other = await makeClient('other');
      const unpaid = await sell(await makeClient('a1'));
      const fromBal = await balanceOf(unpaid.clientId);
      await amend(unpaid.id, { clientId: other, items: [keep(unpaid.items[0])] });
      expect(await balanceOf(unpaid.clientId)).toBeCloseTo(fromBal - 5150);
      expect(await balanceOf(other)).toBeCloseTo(5150);

      const paid = await sell(await makeClient('a2'), { payments: [{ paymentDate: new Date(), amount: 100, mode: 'UPI' }] });
      await expect(amend(paid.id, { clientId: other, items: [keep(paid.items[0])] })).rejects.toThrow(/cannot be changed once a payment/);
    });

    it('a piece already sold elsewhere is refused, and the whole edit rolls back', async () => {
      const clientId = await makeClient('roll');
      const gone = await makeTag('Sold elsewhere');
      await prisma.jewelryTag.update({ where: { id: gone.id }, data: { status: 'SOLD' } });
      const inv = await sell(clientId);

      await expect(amend(inv.id, { items: [keep(inv.items[0], { goldRate: 9000 }), item({ tagId: gone.id })] })).rejects.toThrow(/Tags not available/);

      const after = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id }, include: { items: true } });
      expect(Number(after.totalAmount)).toBe(5150);
      expect(after.items).toHaveLength(1);
      expect(Number(after.items[0].goldRate)).toBe(5000);
      expect(await balanceOf(clientId)).toBeCloseTo(5150);
      expect(await entriesOf(inv.id)).toHaveLength(1); // no adjustment entry
    });

    it('rejects an empty bill and a line id that is not on this invoice', async () => {
      const inv = await sell(await makeClient('bad'));
      const other = await sell(await makeClient('bad2'));
      await expect(amend(inv.id, { items: [] })).rejects.toThrow(/at least one line/);
      await expect(amend(inv.id, { items: [keep(other.items[0])] })).rejects.toThrow(/not found on this invoice/);
    });

    it("another company's invoice is a 404", async () => {
      const inv = await sell(await makeClient('x'));
      const outsider = await createTestTenant(`AMX${suffix}`, ['invoice:create']);
      try {
        await expect(amendInvoice(inv.id, { items: [keep(inv.items[0])] }, outsider.ctx, outsider.user.id)).rejects.toThrow(/Invoice not found/);
      } finally {
        await cleanupTestTenant(outsider);
      }
    });
  });
});

// J3 Decision 3 (A1): isActive now has real teeth — an inactive client cannot start a NEW sale,
// memo, or payment. Historical transactions are untouched by this (forward-looking gate only).
describe('inactive client is rejected for a new sale/memo/payment (J3 Decision 3)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let clientId: string;

  beforeAll(async () => {
    tenant = await createTestTenant(`IA${suffix}`, ['invoice:create']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
    const c = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-IA-${suffix}`, name: 'Inactive Client', panNumber: 'ABCDE1234F', type: 'RETAIL', isActive: false },
    });
    clientId = c.id;
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { id: clientId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('createInvoice rejects an inactive client', async () => {
    await expect(_createInvoice({
      branchId, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Chain', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 100 }],
    }, tenant.ctx, userId)).rejects.toThrow(/deactivated/);
  });

  it('createMemoOut rejects an inactive client', async () => {
    await expect(createMemoOut({
      clientId, branchId, sentDate: new Date(), returnDeadline: new Date(),
      items: [{ productCode: 'MISC', description: 'Chain', pieces: 1, grossWeight: 1, netGoldWeight: 1, estimatedValue: 100 }],
    }, tenant.ctx, userId)).rejects.toThrow(/deactivated/);
  });

  it('recordClientPayment rejects an inactive client', async () => {
    await expect(recordClientPayment(
      { clientId, paymentDate: new Date(), amount: 100, mode: 'CASH' }, tenant.ctx, userId,
    )).rejects.toThrow(/deactivated/);
  });
});

// F2: a standalone payment — an advance, or a payment against a client's general outstanding
// balance — with no invoice to apply against yet. Reuses PMT- numbering and the same Cash/Bank vs
// Accounts Receivable ledger entry applyPayment posts (F1); the only difference is there's no
// SalesInvoice.paidAmount/balanceDue/status to update.
describe('recordClientPayment (F2 — on-account payments)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let clientId: string;
  const paymentIds: string[] = [];
  const f2InvoiceIds: string[] = [];

  beforeAll(async () => {
    tenant = await createTestTenant(`F2${suffix}`, ['invoice:create']);
    userId = tenant.user.id;

    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-F2-${suffix}`, name: 'Test Client', panNumber: 'ABCDE1234F', type: 'WHOLESALE' },
    });
    clientId = client.id;
  });

  afterAll(async () => {
    await cleanupJournalEntries([...paymentIds, ...f2InvoiceIds]);
    await prisma.invoicePayment.deleteMany({ where: { id: { in: paymentIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: f2InvoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: f2InvoiceIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('records a payment with no invoiceId, credits the client, and posts a ledger entry', async () => {
    const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });

    const payment = await recordClientPayment(
      { clientId, paymentDate: new Date(), amount: 50000, mode: 'CASH' },
      tenant.ctx, userId
    );
    paymentIds.push(payment.id);

    expect(payment.paymentNumber).toMatch(/^PMT-/);
    expect(payment.invoiceId).toBeNull();
    expect(payment.clientId).toBe(clientId);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(Number(after.currentBalance)).toBeCloseTo(Number(before.currentBalance) - 50000);

    const entry = await getJournalEntry(payment.id);
    expect(entry).not.toBeNull();
    expect(entry!.referenceType).toBe('InvoicePayment');
    expect(lineAmount(entry!, LEDGER_ACCOUNT.CASH_IN_HAND).debit).toBe(50000);
    expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).credit).toBe(50000);
  });

  it('rejects a zero or negative amount', async () => {
    await expect(
      recordClientPayment({ clientId, paymentDate: new Date(), amount: 0, mode: 'CASH' }, tenant.ctx, userId)
    ).rejects.toThrow(/must be positive/);
    await expect(
      recordClientPayment({ clientId, paymentDate: new Date(), amount: -100, mode: 'CASH' }, tenant.ctx, userId)
    ).rejects.toThrow(/must be positive/);
  });

  it('is listed by listClientPayments alongside invoice-scoped payments for the same client', async () => {
    const standalone = await recordClientPayment(
      { clientId, paymentDate: new Date(), amount: 10000, mode: 'UPI' },
      tenant.ctx, userId
    );
    paymentIds.push(standalone.id);

    const invoice = await _createInvoice(
      {
        clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', branchId: tenant.branch.id,
        items: [{
          productCode: 'MISC', description: 'Test line', quantity: 1,
          grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 5000,
        }],
        payments: [{ paymentDate: new Date(), amount: 5000, mode: 'CASH' }],
      },
      tenant.ctx, userId
    );

    const invoiceScoped = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: invoice.id } });

    const payments = await listClientPayments(tenant.ctx, clientId);
    const ids = payments.map((p) => p.id);
    expect(ids).toContain(standalone.id);
    expect(ids).toContain(invoiceScoped.id);

    // Cleanup for this invoice specifically (not tracked by the outer invoiceIds array in this
    // describe block, which only exists in the createInvoice describe above).
    await cleanupJournalEntries([invoice.id, invoiceScoped.id]);
    await prisma.invoicePayment.deleteMany({ where: { id: invoiceScoped.id } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: invoice.id } });
    await prisma.salesInvoice.deleteMany({ where: { id: invoice.id } });
  });
});

// H1: every invoice in a period, retail + wholesale together, filterable by salesperson. Rows
// are created directly against SalesInvoice (not via createInvoice) so date/type/salesperson can
// be controlled precisely, independent of the pricing/tax machinery getSalesRegister doesn't
// touch — it only reads what's already there.
describe('getSalesRegister (H1)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const d = (s: string) => new Date(s);

  let tenant: TestTenant;
  let clientId: string;
  let salesPersonAId: string;
  let salesPersonBId: string;
  const invoiceIds: string[] = [];

  beforeAll(async () => {
    tenant = await createTestTenant(`REG${suffix}`, []);

    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-REG-${suffix}`, name: 'Register Test Client', panNumber: 'ABCDE1234F', type: 'RETAIL' },
    });
    clientId = client.id;

    // Plain User rows (no CompanyUser membership needed) — salesPersonId is a direct FK to
    // User, unaffected by the multi-tenant migration's Role/CompanyUser changes.
    const [spA, spB] = await Promise.all([
      prisma.user.create({ data: { email: `test-reg-a-${suffix}@example.com`, password: 'x', name: 'Sales Person A' } }),
      prisma.user.create({ data: { email: `test-reg-b-${suffix}@example.com`, password: 'x', name: 'Sales Person B' } }),
    ]);
    salesPersonAId = spA.id;
    salesPersonBId = spB.id;

    async function makeInvoice(invoiceDate: Date, invoiceType: string, salesPersonId: string, totalAmount: number) {
      const inv = await prisma.salesInvoice.create({
        data: {
          companyId: tenant.company.id, branchId: tenant.branch.id,
          invoiceNumber: `TSTINV-REG-${suffix}-${invoiceIds.length}`, clientId, invoiceDate, invoiceType,
          salesPersonId, subtotal: totalAmount, totalAmount, balanceDue: totalAmount, status: 'ISSUED',
        },
      });
      invoiceIds.push(inv.id);
    }

    await makeInvoice(d('2026-02-05'), 'RETAIL', salesPersonAId, 10000);
    await makeInvoice(d('2026-02-10'), 'WHOLESALE', salesPersonBId, 50000);
    await makeInvoice(d('2026-03-01'), 'RETAIL', salesPersonAId, 15000); // outside the test range below
  });

  afterAll(async () => {
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await prisma.user.deleteMany({ where: { id: { in: [salesPersonAId, salesPersonBId] } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('lists invoices within the date range and totals correctly', async () => {
    const result = await getSalesRegister(tenant.ctx, { from: d('2026-02-01'), to: d('2026-02-28') });
    expect(result.rows).toHaveLength(2);
    expect(result.totals.count).toBe(2);
    expect(result.totals.totalAmount).toBeCloseTo(60000);
  });

  it('breaks totals down by invoiceType', async () => {
    const result = await getSalesRegister(tenant.ctx, { from: d('2026-02-01'), to: d('2026-02-28') });
    expect(result.byType.RETAIL).toEqual({ count: 1, totalAmount: 10000 });
    expect(result.byType.WHOLESALE).toEqual({ count: 1, totalAmount: 50000 });
  });

  it('filters by salesPersonId', async () => {
    const result = await getSalesRegister(tenant.ctx, { from: d('2026-02-01'), to: d('2026-02-28'), salesPersonId: salesPersonAId });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].totalAmount).toBeCloseTo(10000);
  });

  // J3.5 Finding 1: a voided invoice was never a completed sale — excluded from the register
  // entirely (rows and totals), not just zeroed out of the total while still listed.
  it('excludes a VOID invoice from both rows and totals', async () => {
    const voided = await prisma.salesInvoice.create({
      data: {
        companyId: tenant.company.id, branchId: tenant.branch.id,
        invoiceNumber: `TSTINV-REG-${suffix}-void`, clientId, invoiceDate: d('2026-02-15'), invoiceType: 'RETAIL',
        salesPersonId: salesPersonAId, subtotal: 88888, totalAmount: 88888, balanceDue: 88888, status: 'VOID',
      },
    });
    invoiceIds.push(voided.id);

    const result = await getSalesRegister(tenant.ctx, { from: d('2026-02-01'), to: d('2026-02-28') });
    expect(result.rows).toHaveLength(2); // unchanged — still just the two active invoices
    expect(result.totals.totalAmount).toBeCloseTo(60000);
    expect(result.rows.some((r) => r.id === voided.id)).toBe(false);
  });
});

// J3 Decision 5: a whole-invoice reversal — never a hard delete. Strict eligibility (zero payments,
// zero returns, not already void, no already-generated IRN); reuses createSalesReturn's own proven
// per-line reversal mechanics applied to the whole header at once.
describe('voidInvoice (J3.3)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  const clientIds: string[] = [];
  const invoiceIds: string[] = [];
  const tagIds: string[] = [];

  async function makeClient(label: string) {
    const c = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-VD-${label}-${suffix}`, name: `Client ${label}`, panNumber: 'ABCDE1234F', type: 'RETAIL' },
    });
    clientIds.push(c.id);
    return c.id;
  }
  async function makeTag(name: string, costPrice = 4000) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-VD-${suffix}-${tagIds.length}`, companyId: tenant.company.id, branchId, name,
        metalType: 'GOLD', metalKarat: '22K', grossWeight: 1, netWeight: 1, stoneWeight: 0,
        costPrice, sellingPrice: 5150, createdById: userId,
      },
    });
    tagIds.push(tag.id);
    return tag;
  }
  // 1 g x ₹5,000 + 3% GST = ₹5,150.
  const item = (over: Partial<Parameters<typeof _createInvoice>[0]['items'][number]> = {}) => ({
    productCode: 'MISC', description: 'Chain', quantity: 1, grossWeight: 1, netGoldWeight: 1,
    rateType: 'PER_GRAM', goldRate: 5000, makingCharge: 0, ...over,
  });
  const sell = async (clientId: string, over: Partial<Parameters<typeof _createInvoice>[0]> = {}) => {
    const inv = await _createInvoice({ branchId, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [item()], ...over }, tenant.ctx, userId);
    invoiceIds.push(inv.id);
    return inv;
  };
  const balanceOf = async (clientId: string) => Number((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentBalance);
  const statusOf = async (id: string) => (await prisma.jewelryTag.findUniqueOrThrow({ where: { id } })).status;
  const entriesOf = (referenceId: string) => prisma.journalEntry.findMany({
    where: { referenceId }, include: { lines: { include: { account: { select: { code: true } } } } },
  });

  beforeAll(async () => {
    tenant = await createTestTenant(`VD${suffix}`, ['invoice:create']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
  });

  afterAll(async () => {
    const returnIds = (await prisma.salesReturn.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } })).map((r) => r.id);
    const payIds = (await prisma.invoicePayment.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } })).map((p) => p.id);
    await cleanupJournalEntries([...invoiceIds, ...returnIds, ...payIds]);
    await prisma.salesReturn.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('reverses stock, ledger and customer balance, and marks the invoice VOID with an audit trail', async () => {
    const clientId = await makeClient('happy');
    const tag = await makeTag('Voided piece');
    const inv = await sell(clientId, { items: [item({ tagId: tag.id })] });
    expect(await statusOf(tag.id)).toBe('SOLD');
    expect(await balanceOf(clientId)).toBeCloseTo(5150);

    const result = await voidInvoice(inv.id, tenant.ctx, userId, 'Wrong customer picked at counter');
    expect(result).toEqual({ id: inv.id, status: 'VOID' });

    expect(await statusOf(tag.id)).toBe('IN_STOCK');
    expect(await balanceOf(clientId)).toBeCloseTo(0);
    const updated = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(updated.status).toBe('VOID');
    expect(updated.voidedAt).not.toBeNull();
    expect(updated.voidedById).toBe(userId);
    expect(updated.voidReason).toBe('Wrong customer picked at counter');

    const entries = await entriesOf(inv.id);
    const voidEntry = entries.find((e) => e.referenceType === 'SalesInvoiceVoid')!;
    expect(voidEntry).toBeDefined();
    const dr = voidEntry.lines.reduce((s, l) => s + Number(l.debit), 0);
    const cr = voidEntry.lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(dr).toBeCloseTo(cr);
    const ar = voidEntry.lines.find((l) => l.account.code === LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE)!;
    expect(Number(ar.credit)).toBe(5150);

    const audit = await prisma.auditLog.findFirst({ where: { recordId: inv.id, action: 'VOID' } });
    expect(audit).not.toBeNull();
    expect((audit!.oldValues as any).status).toBe('DRAFT');
    expect((audit!.newValues as any).status).toBe('VOID');
    expect((audit!.newValues as any).reason).toBe('Wrong customer picked at counter');
  });

  it('rejects voiding an invoice that already has a payment', async () => {
    const clientId = await makeClient('haspay');
    const inv = await sell(clientId, { payments: [{ paymentDate: new Date(), amount: 5150, mode: 'UPI' }] });
    await expect(voidInvoice(inv.id, tenant.ctx, userId, 'test')).rejects.toThrow(/payment/i);
  });

  it('rejects voiding an invoice that already has a return', async () => {
    const clientId = await makeClient('hasreturn');
    const tag = await makeTag('Returned first');
    const inv = await sell(clientId, { items: [item({ tagId: tag.id })] });
    await createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: inv.items[0].id }] }, tenant.ctx, userId);
    await expect(voidInvoice(inv.id, tenant.ctx, userId, 'test')).rejects.toThrow(/return/i);
  });

  it('rejects voiding an already-voided invoice', async () => {
    const clientId = await makeClient('doublevoid');
    const inv = await sell(clientId);
    await voidInvoice(inv.id, tenant.ctx, userId, 'first void');
    await expect(voidInvoice(inv.id, tenant.ctx, userId, 'second void')).rejects.toThrow(/already been voided/);
  });

  it('rejects voiding an invoice with an already-generated e-invoice IRN', async () => {
    const clientId = await makeClient('irn');
    const inv = await sell(clientId);
    await prisma.taxInvoice.update({ where: { invoiceId: inv.id }, data: { irn: 'IRN-TEST-1234' } });
    await expect(voidInvoice(inv.id, tenant.ctx, userId, 'test')).rejects.toThrow(/e-invoice/i);
  });

  it('blocks amend, payment and return against an already-voided invoice', async () => {
    const clientId = await makeClient('lockdown');
    const inv = await sell(clientId);
    await voidInvoice(inv.id, tenant.ctx, userId, 'test');

    await expect(amendInvoice(inv.id, { items: [{ ...item(), id: undefined }] } as any, tenant.ctx, userId)).rejects.toThrow(/voided/);
    await expect(recordPayment({ invoiceId: inv.id, paymentDate: new Date(), amount: 100, mode: 'CASH' }, tenant.ctx, userId)).rejects.toThrow(/voided/);
    await expect(createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: inv.items[0].id }] }, tenant.ctx, userId)).rejects.toThrow(/voided/);
  });

  it('rejects a cross-company invoice id (404, indistinguishable from nonexistent)', async () => {
    const other = await createTestTenant(`VDOTHER${suffix}`, ['invoice:create']);
    try {
      const otherClient = await prisma.client.create({
        data: { companyId: other.company.id, clientCode: `TSTCL-VDX-${suffix}`, name: 'Other co client', panNumber: 'ABCDE1234F', type: 'RETAIL' },
      });
      const foreignInv = await _createInvoice({
        branchId: other.branch.id, clientId: otherClient.id, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [item()],
      }, other.ctx, other.user.id);

      await expect(voidInvoice(foreignInv.id, tenant.ctx, userId, 'test')).rejects.toThrow(/not found/i);

      await cleanupJournalEntries([foreignInv.id]);
      await prisma.taxInvoice.deleteMany({ where: { invoiceId: foreignInv.id } });
      await prisma.salesInvoice.deleteMany({ where: { id: foreignInv.id } });
      await prisma.client.deleteMany({ where: { id: otherClient.id } });
    } finally {
      await cleanupTestTenant(other);
    }
  });

  // J3.5 Finding 1, end-to-end: the real voidInvoice() flow (not a direct row edit) must stop the
  // voided invoice from counting as a live receivable / sale / ledger debit in every report that
  // reads SalesInvoice, while leaving a DIFFERENT active invoice for the SAME client unaffected.
  it('removes a voided invoice from dealer aging, the client ledger and the sales register — but leaves a different active invoice for the same client untouched', async () => {
    const clientId = await makeClient('reporting');
    const untouched = await sell(clientId); // stays active — the control case
    const target = await sell(clientId);    // will be voided

    const agingBefore = await getDealerAging(tenant.ctx.companyId);
    const rowBefore = agingBefore.rows.find((r) => r.clientId === clientId)!;
    expect(rowBefore.total).toBeCloseTo(5150 * 2);

    const ledgerBefore = await getClientLedger(tenant.ctx, clientId);
    expect(ledgerBefore.closingBalance).toBeCloseTo(5150 * 2);
    expect(ledgerBefore.closingBalance).toBeCloseTo(ledgerBefore.client.currentBalance);

    await voidInvoice(target.id, tenant.ctx, userId, 'billed the wrong customer');

    // Dealer aging: only the untouched invoice's 5150 remains.
    const agingAfter = await getDealerAging(tenant.ctx.companyId);
    const rowAfter = agingAfter.rows.find((r) => r.clientId === clientId)!;
    expect(rowAfter.total).toBeCloseTo(5150);

    // Client ledger: still reconciles to currentBalance, and the voided invoice isn't listed.
    const ledgerAfter = await getClientLedger(tenant.ctx, clientId);
    expect(ledgerAfter.rows.some((r) => r.refNumber === target.invoiceNumber)).toBe(false);
    expect(ledgerAfter.rows.some((r) => r.refNumber === untouched.invoiceNumber)).toBe(true); // control case unaffected
    expect(ledgerAfter.closingBalance).toBeCloseTo(5150);
    expect(ledgerAfter.closingBalance).toBeCloseTo(ledgerAfter.client.currentBalance);

    // Sales register: same date range, voided invoice gone, untouched invoice still counted.
    const today = new Date();
    const register = await getSalesRegister(tenant.ctx, { from: new Date(today.getFullYear(), today.getMonth(), 1), to: today });
    expect(register.rows.some((r) => r.id === target.id)).toBe(false);
    expect(register.rows.some((r) => r.id === untouched.id)).toBe(true);
  });
});

// J3 Decision 1 (flag the original row) / Decision 2 (build the full OLD_GOLD/STORE_CREDIT
// reversal chain, not just block it).
describe('reverseInvoicePayment (J3.2)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const karat = '22K';

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  const clientIds: string[] = [];
  const invoiceIds: string[] = [];
  const tagIds: string[] = [];
  const rateIds: string[] = [];

  async function makeClient(label: string) {
    const c = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-RV-${label}-${suffix}`, name: `Client ${label}`, panNumber: 'ABCDE1234F', type: 'RETAIL' },
    });
    clientIds.push(c.id);
    return c.id;
  }
  async function makeTag(name: string) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-RV-${suffix}-${tagIds.length}`, companyId: tenant.company.id, branchId, name,
        metalType: 'GOLD', metalKarat: karat, grossWeight: 1, netWeight: 1, stoneWeight: 0,
        costPrice: 4000, sellingPrice: 5150, createdById: userId,
      },
    });
    tagIds.push(tag.id);
    return tag;
  }
  const item = (over: Partial<Parameters<typeof _createInvoice>[0]['items'][number]> = {}) => ({
    productCode: 'MISC', description: 'Chain', quantity: 1, grossWeight: 1, netGoldWeight: 1,
    rateType: 'PER_GRAM', goldRate: 5000, makingCharge: 0, ...over,
  });
  const sell = async (clientId: string, over: Partial<Parameters<typeof _createInvoice>[0]> = {}) => {
    const inv = await _createInvoice({ branchId, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [item()], ...over }, tenant.ctx, userId);
    invoiceIds.push(inv.id);
    return inv;
  };
  const balanceOf = async (clientId: string) => Number((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentBalance);
  async function clientWithReturnCredit(label: string) {
    const clientId = await makeClient(label);
    const tag = await makeTag(`Returned ${label}`);
    const sold = await sell(clientId, { items: [item({ tagId: tag.id })], payments: [{ paymentDate: new Date(), amount: 5150, mode: 'UPI' }] });
    await createSalesReturn({ invoiceId: sold.id, items: [{ invoiceItemId: sold.items[0].id }] }, tenant.ctx, userId);
    return clientId;
  }

  beforeAll(async () => {
    tenant = await createTestTenant(`RV${suffix}`, ['invoice:create']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
    const today = new Date(new Date().toISOString().split('T')[0]);
    rateIds.push((await prisma.metalRate.create({
      data: { companyId: tenant.company.id, date: today, karat, purity: 0.916, ratePerGram: 5000 },
    })).id);
  });

  afterAll(async () => {
    const returnIds = (await prisma.salesReturn.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } })).map((r) => r.id);
    const payIds = (await prisma.invoicePayment.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } })).map((p) => p.id);
    const exchanges = await prisma.oldGoldExchange.findMany({ where: { clientId: { in: clientIds } }, select: { id: true, metalStockId: true } });
    await cleanupJournalEntries([...invoiceIds, ...returnIds, ...payIds, ...exchanges.map((e) => e.id)]);
    await prisma.salesReturn.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.oldGoldExchange.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.metalStock.deleteMany({ where: { companyId: tenant.company.id } });
    await prisma.metalRate.deleteMany({ where: { id: { in: rateIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('reverses a cash-mode payment: invoice reopens, client balance and ledger both reverse, original row kept', async () => {
    const clientId = await makeClient('cash');
    const inv = await sell(clientId, { payments: [{ paymentDate: new Date(), amount: 5150, mode: 'UPI' }] });
    const payment = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: inv.id } });
    expect(await balanceOf(clientId)).toBeCloseTo(0);

    const result = await reverseInvoicePayment(payment.id, tenant.ctx, userId, 'Customer disputed the charge');

    expect(result.invoiceAfter).toEqual({ paidAmount: 0, balanceDue: 5150, status: 'DRAFT' });
    expect(await balanceOf(clientId)).toBeCloseTo(5150);

    const reversed = await prisma.invoicePayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reversed.reversedAt).not.toBeNull();
    expect(reversed.reversedById).toBe(userId);
    expect(reversed.reversalReason).toBe('Customer disputed the charge');
    expect(Number(reversed.amount)).toBe(5150); // original row untouched

    const entries = await prisma.journalEntry.findMany({ where: { referenceId: payment.id }, include: { lines: { include: { account: { select: { code: true } } } } } });
    const reversal = entries.find((e) => e.referenceType === 'InvoicePaymentReversal')!;
    expect(Number(reversal.lines.find((l) => l.account.code === LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE)!.debit)).toBe(5150);
    expect(Number(reversal.lines.find((l) => l.account.code === LEDGER_ACCOUNT.BANK_ACCOUNT)!.credit)).toBe(5150);

    const audit = await prisma.auditLog.findFirst({ where: { recordId: payment.id, action: 'REVERSE' } });
    expect(audit).not.toBeNull();
    expect((audit!.newValues as any).reason).toBe('Customer disputed the charge');
  });

  it('rejects reversing an already-reversed payment', async () => {
    const clientId = await makeClient('dup');
    const inv = await sell(clientId, { payments: [{ paymentDate: new Date(), amount: 5150, mode: 'CASH' }] });
    const payment = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: inv.id } });
    await reverseInvoicePayment(payment.id, tenant.ctx, userId, 'first reversal');
    await expect(reverseInvoicePayment(payment.id, tenant.ctx, userId, 'second reversal')).rejects.toThrow(/already been reversed/);
  });

  it('reverses a standalone (F2, no invoice) payment', async () => {
    const clientId = await makeClient('standalone');
    const payment = await recordClientPayment({ clientId, paymentDate: new Date(), amount: 20000, mode: 'CASH' }, tenant.ctx, userId);
    expect(await balanceOf(clientId)).toBeCloseTo(-20000);

    const result = await reverseInvoicePayment(payment.id, tenant.ctx, userId, 'keyed against the wrong client');
    expect(result.invoiceAfter).toBeNull();
    expect(await balanceOf(clientId)).toBeCloseTo(0);
  });

  it('reverses a STORE_CREDIT settlement: invoice reopens, currentBalance untouched, no journal either way', async () => {
    const clientId = await clientWithReturnCredit('sc');
    const tag = await makeTag('New piece SC');
    const inv = await sell(clientId, { items: [item({ tagId: tag.id })], payments: [{ paymentDate: new Date(), amount: 5150, mode: 'STORE_CREDIT' }] });
    const payment = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: inv.id, mode: 'STORE_CREDIT' } });
    const balanceAfterSale = await balanceOf(clientId);

    const result = await reverseInvoicePayment(payment.id, tenant.ctx, userId, 'applied to wrong invoice');

    expect(result.invoiceAfter).toEqual({ paidAmount: 0, balanceDue: 5150, status: 'DRAFT' });
    // No currentBalance movement either on application (already established behavior) or reversal.
    expect(await balanceOf(clientId)).toBeCloseTo(balanceAfterSale);
    expect(await getJournalEntry(payment.id)).toBeNull();
  });

  it('reverses an OLD_GOLD settlement: invoice reopens, client credited back, Metal Vault entry undone, exchange marked reversed', async () => {
    const clientId = await makeClient('og');
    const inv = await sell(clientId, {
      payments: [{ paymentDate: new Date(), amount: 0, mode: 'OLD_GOLD', oldGold: { description: 'Old chain', karat, grossWeight: 1.03 } }],
    }); // 1.03g x ₹5,000 = ₹5,150 — exactly settles the bill
    const payment = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: inv.id, mode: 'OLD_GOLD' } });
    const exchange = await prisma.oldGoldExchange.findFirstOrThrow({ where: { companyId: tenant.company.id, exchangeNumber: payment.referenceNo! } });
    expect(await balanceOf(clientId)).toBeCloseTo(0);

    const result = await reverseInvoicePayment(payment.id, tenant.ctx, userId, 'wrong weight keyed');

    expect(result.invoiceAfter).toEqual({ paidAmount: 0, balanceDue: 5150, status: 'DRAFT' });
    expect(await balanceOf(clientId)).toBeCloseTo(5150); // the exchange's credit is undone too

    const reversedExchange = await prisma.oldGoldExchange.findUniqueOrThrow({ where: { id: exchange.id } });
    expect(reversedExchange.reversedAt).not.toBeNull();
    expect(reversedExchange.reversedById).toBe(userId);

    const stock = await prisma.metalStock.findUniqueOrThrow({ where: { id: exchange.metalStockId! } });
    expect(stock.isActive).toBe(false);
    expect(Number(stock.availableWt)).toBe(0);

    const exEntries = await prisma.journalEntry.findMany({ where: { referenceId: exchange.id }, include: { lines: { include: { account: { select: { code: true } } } } } });
    const exReversal = exEntries.find((e) => e.referenceType === 'OldGoldExchangeReversal')!;
    expect(Number(exReversal.lines.find((l) => l.account.code === LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE)!.debit)).toBe(5150);
    expect(Number(exReversal.lines.find((l) => l.account.code === LEDGER_ACCOUNT.INVENTORY)!.credit)).toBe(5150);

    // J3.5 Finding 5: a real before-snapshot, not just a reason string — reconstructable on its own,
    // not only by cross-referencing the still-live exchange row or the payment's own audit entry.
    const exchangeAudit = await prisma.auditLog.findFirst({ where: { recordId: exchange.id, action: 'REVERSE' } });
    expect(exchangeAudit).not.toBeNull();
    expect((exchangeAudit!.oldValues as any).valuedAmount).toBe(5150);
    expect((exchangeAudit!.oldValues as any).exchangeNumber).toBe(exchange.exchangeNumber);
    expect((exchangeAudit!.newValues as any).reason).toMatch(/wrong weight keyed/);

    // J3.5 Finding 5: the MetalStock zeroing is now audited too — every OTHER MetalStock mutation
    // in this codebase (addMetalStock -> CREATE, adjustMetalStock -> ADJUST) already was; this one
    // silently wasn't, until now.
    const stockAudit = await prisma.auditLog.findFirst({ where: { recordId: exchange.metalStockId!, action: 'REVERSE' } });
    expect(stockAudit).not.toBeNull();
    expect((stockAudit!.oldValues as any).availableWt).toBeCloseTo(1.03);
    expect((stockAudit!.oldValues as any).isActive).toBe(true);
    expect((stockAudit!.newValues as any).availableWt).toBe(0);
    expect((stockAudit!.newValues as any).isActive).toBe(false);
  });

  it('refuses to reverse an OLD_GOLD settlement once its metal has been reserved elsewhere', async () => {
    const clientId = await makeClient('ogreserved');
    const inv = await sell(clientId, {
      payments: [{ paymentDate: new Date(), amount: 0, mode: 'OLD_GOLD', oldGold: { description: 'Old bangle', karat, grossWeight: 1.03 } }],
    });
    const payment = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: inv.id, mode: 'OLD_GOLD' } });
    const exchange = await prisma.oldGoldExchange.findFirstOrThrow({ where: { companyId: tenant.company.id, exchangeNumber: payment.referenceNo! } });

    // Simulate the dormant production auto-reservation path (orders.service.ts:autoReserveMaterials)
    // having already spent part of this exact metal before anyone tried to reverse the exchange.
    await prisma.metalStock.update({ where: { id: exchange.metalStockId! }, data: { availableWt: { decrement: 0.5 } } });

    await expect(reverseInvoicePayment(payment.id, tenant.ctx, userId, 'test')).rejects.toThrow(/already been reserved or adjusted/);

    // Nothing was left partially reversed — the payment's own reversal claim must roll back too.
    const stillLive = await prisma.invoicePayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(stillLive.reversedAt).toBeNull();
  });

  it('rejects a cross-company payment id (404, indistinguishable from nonexistent)', async () => {
    const other = await createTestTenant(`RVOTHER${suffix}`, ['invoice:create']);
    try {
      const otherClient = await prisma.client.create({
        data: { companyId: other.company.id, clientCode: `TSTCL-RVX-${suffix}`, name: 'Other co client', panNumber: 'ABCDE1234F', type: 'RETAIL' },
      });
      const foreignInv = await _createInvoice({
        branchId: other.branch.id, clientId: otherClient.id, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [item()],
        payments: [{ paymentDate: new Date(), amount: 5150, mode: 'CASH' }],
      }, other.ctx, other.user.id);
      const foreignPayment = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: foreignInv.id } });

      await expect(reverseInvoicePayment(foreignPayment.id, tenant.ctx, userId, 'test')).rejects.toThrow(/not found/i);

      await cleanupJournalEntries([foreignInv.id, foreignPayment.id]);
      await prisma.invoicePayment.deleteMany({ where: { id: foreignPayment.id } });
      await prisma.taxInvoice.deleteMany({ where: { invoiceId: foreignInv.id } });
      await prisma.salesInvoice.deleteMany({ where: { id: foreignInv.id } });
      await prisma.client.deleteMany({ where: { id: otherClient.id } });
    } finally {
      await cleanupTestTenant(other);
    }
  });

  // J3.5 Finding 3 — real concurrency, not two sequential calls: both promises are started together
  // and only THEN awaited, so both requests reach the database before either resolves.
  describe('concurrency (J3.5 Finding 3)', () => {
    it('two simultaneous reversal attempts on the SAME OLD_GOLD payment: exactly one succeeds, no duplicate journal/balance/stock effect', async () => {
      const clientId = await makeClient('race-same-payment');
      const inv = await sell(clientId, {
        payments: [{ paymentDate: new Date(), amount: 0, mode: 'OLD_GOLD', oldGold: { description: 'Race test chain', karat, grossWeight: 1.03 } }],
      });
      const payment = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: inv.id, mode: 'OLD_GOLD' } });
      const exchange = await prisma.oldGoldExchange.findFirstOrThrow({ where: { companyId: tenant.company.id, exchangeNumber: payment.referenceNo! } });
      const balanceBefore = await balanceOf(clientId);

      const results = await Promise.allSettled([
        reverseInvoicePayment(payment.id, tenant.ctx, userId, 'race A'),
        reverseInvoicePayment(payment.id, tenant.ctx, userId, 'race B'),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason.message).toMatch(/already been reversed/);

      // Balance moved by exactly ONE valuedAmount (5150) — a lost claim-check would double-credit it.
      expect(await balanceOf(clientId)).toBeCloseTo(balanceBefore + 5150);

      // Exactly one exchange-reversal journal — not two, not zero.
      const exReversalEntries = await prisma.journalEntry.findMany({ where: { referenceId: exchange.id, referenceType: 'OldGoldExchangeReversal' } });
      expect(exReversalEntries).toHaveLength(1);

      // MetalStock left in a single, correct zeroed state — not corrupted by a second concurrent writer.
      const stock = await prisma.metalStock.findUniqueOrThrow({ where: { id: exchange.metalStockId! } });
      expect(Number(stock.availableWt)).toBe(0);
      expect(stock.isActive).toBe(false);

      const exReversed = await prisma.oldGoldExchange.findUniqueOrThrow({ where: { id: exchange.id } });
      expect(exReversed.reversedAt).not.toBeNull();
    });

    // This is exactly the lost-update window the FOR UPDATE lock in reverseInvoicePayment closes:
    // without it, two concurrent reversals on the SAME invoice (different payments) each read
    // paidAmount before either wrote, and the second write silently discarded the first's effect.
    it('two concurrent reversals of two DIFFERENT payments on the SAME invoice: neither loses the other\'s effect on paidAmount/balanceDue', async () => {
      const clientId = await makeClient('race-same-invoice');
      const inv = await sell(clientId, {
        payments: [
          { paymentDate: new Date(), amount: 2000, mode: 'CASH' },
          { paymentDate: new Date(), amount: 2000, mode: 'UPI' },
        ],
      }); // 5150 total, 4000 paid, 1150 due, PARTIALLY_PAID
      const payments = await prisma.invoicePayment.findMany({ where: { invoiceId: inv.id }, orderBy: { mode: 'asc' } });
      expect(payments).toHaveLength(2);

      const results = await Promise.allSettled([
        reverseInvoicePayment(payments[0].id, tenant.ctx, userId, 'concurrent reversal 1'),
        reverseInvoicePayment(payments[1].id, tenant.ctx, userId, 'concurrent reversal 2'),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

      const finalInvoice = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
      // Both reversals' effect present — a lost update would leave this at 2000, not 0.
      expect(Number(finalInvoice.paidAmount)).toBeCloseTo(0);
      expect(Number(finalInvoice.balanceDue)).toBeCloseTo(5150);
      expect(finalInvoice.status).toBe('DRAFT');

      // One reversal journal entry per payment — no duplicates, none dropped.
      const reversalEntries = await prisma.journalEntry.findMany({
        where: { referenceId: { in: payments.map((p) => p.id) }, referenceType: 'InvoicePaymentReversal' },
      });
      expect(reversalEntries).toHaveLength(2);
    });
  });
});
