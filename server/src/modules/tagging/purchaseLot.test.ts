import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { FINISHED_LOT_MATERIAL_TYPE } from '../../shared/constants';
import { allocateLotCost } from '../../shared/purchaseLot';
import { createPO, createGRN, createPurchaseReturn, listReturnableTags } from '../procurement/procurement.service';
import { createTag as _createTag, updateTag } from './tagging.service';
import { listPurchaseLots, getPurchaseLot, closePurchaseLot } from './purchaseLot.service';
import { getPurchaseGstSummary, getSupplierLedger } from '../finance/finance.service';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { cleanupJournalEntries, getJournalEntry, lineAmount } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// Purchase lots (bags): a supplier bills a bag of finished pieces as ONE invoice line with ONE amount, and says
// what is in it category by category (gross / stone / net, sometimes a piece count, each with its own karat).
// The PO carries that line, the GRN opens the lot (and books the whole bill), and the pieces are tagged one at
// a time from New Tag with the lot chosen — each carrying its share of the bag's cost, by net weight.
describe('purchase lots (PO bag line -> GRN opens the lot -> tag pieces out of it)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let stockTypeId: string;
  let ringCat: string;         // in every test bag
  let neckCat: string;         // in every test bag
  let otherCat: string;        // in NO bag
  let supplierId: string;      // GSTIN prefix 24 == company state 24 -> CGST + SGST
  let otherStateSupplierId: string;
  const poIds: string[] = [];
  const lotIds: string[] = [];
  const tagIds: string[] = [];
  const returnIds: string[] = [];

  const createTag = (data: Partial<Parameters<typeof _createTag>[1]>) => _createTag(tenant.ctx, {
    branchId, name: 'Lot piece', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 9,
    stockTypeId, categoryId: ringCat, ...data,
  }, userId).then((t) => { tagIds.push(t.id); return t; });

  // The standard bag: ₹1,00,000 for 60 g gross —
  //   Rings 22K     gross 40 / stone 4 / net 36, 4 pieces
  //   Necklaces 22K gross 20 / stone 2 / net 18, no piece count
  // so the bag's net is 54 g, and there is no total piece count (one category didn't give one).
  const ringRow = (extra: Record<string, unknown> = {}) => ({ categoryId: ringCat, karat: '22K', grossWeight: 40, netWeight: 36, pieces: 4, ...extra });
  const neckRow = (extra: Record<string, unknown> = {}) => ({ categoryId: neckCat, karat: '22K', grossWeight: 20, stoneWeight: 2, ...extra });
  const bagLine = (extra: Record<string, unknown> = {}) => ({
    materialCode: 'BAG-1', materialName: '22K Gold Bag', materialType: FINISHED_LOT_MATERIAL_TYPE,
    quantity: 1, weight: 60, unit: 'BAG', ratePerUnit: 0, lotAmount: 100000,
    categories: [ringRow(), neckRow()], ...extra,
  });

  // PO -> GRN for one bag line; returns the opened lot.
  async function receiveLot(opts: { supplier?: string; line?: Record<string, unknown> } = {}) {
    const po = await createPO({
      supplierId: opts.supplier ?? supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [bagLine(opts.line)],
    }, tenant.ctx, userId);
    poIds.push(po.id);
    const grn = await createGRN({
      poId: po.id, receivedDate: new Date(), branchId, invoiceNumber: `LOT-INV-${poIds.length}`, invoiceDate: new Date(),
      items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 60, scaleWeight: 60 }],
    }, tenant.ctx, userId);
    const lot = await prisma.purchaseLot.findUniqueOrThrow({ where: { grnItemId: grn.grnItems[0].id } });
    lotIds.push(lot.id);
    return { po, grn, lot };
  }

  const supplierDue = async (id: string) => Number((await prisma.supplier.findUniqueOrThrow({ where: { id } })).currentDue);
  const mkCategory = async (code: string, name: string) => (await prisma.productCategory.create({
    data: { companyId: tenant.company.id, code: `${code}-${suffix}`, name },
  })).id;

  beforeAll(async () => {
    tenant = await createTestTenant(`LOT${suffix}`, ['po:create', 'grn:create', 'tag:create', 'po:approve']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
    stockTypeId = (await prisma.stockType.create({
      data: { companyId: tenant.company.id, code: `L${suffix}`.slice(0, 8).toUpperCase(), name: 'Lot Stock Type' },
    })).id;
    ringCat = await mkCategory('LRING', 'Rings');
    neckCat = await mkCategory('LNECK', 'Necklaces');
    otherCat = await mkCategory('LOTHER', 'Bangles');
    supplierId = (await prisma.supplier.create({
      data: { companyId: tenant.company.id, supplierCode: `LOTSUP-${suffix}`, name: 'Lot Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z5' },
    })).id;
    otherStateSupplierId = (await prisma.supplier.create({
      data: { companyId: tenant.company.id, supplierCode: `LOTOS-${suffix}`, name: 'Other-state Lot Supplier', type: 'OTHER', gstNumber: '27AAAAA0000A1Z5' },
    })).id;
  });

  afterAll(async () => {
    await cleanupJournalEntries([...lotIds, ...returnIds]);
    await prisma.purchaseReturn.deleteMany({ where: { id: { in: returnIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.purchaseLot.deleteMany({ where: { id: { in: lotIds } } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });   // its category rows go with it
    await prisma.supplier.deleteMany({ where: { id: { in: [supplierId, otherStateSupplierId] } } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await prisma.productCategory.deleteMany({ where: { id: { in: [ringCat, neckCat, otherCat] } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  describe('allocateLotCost (pure)', () => {
    it('splits the remaining cost by net weight and lets the last piece take the remainder', () => {
      expect(allocateLotCost({ remainingCost: 100000, remainingNet: 36, pieceNet: 9, isLastPiece: false })).toBe(25000);
      expect(allocateLotCost({ remainingCost: 50000, remainingNet: 18, pieceNet: 8, isLastPiece: false })).toBe(22222.22);
      expect(allocateLotCost({ remainingCost: 27777.78, remainingNet: 10, pieceNet: 10, isLastPiece: true })).toBe(27777.78);
    });
    it('never hands out more than what is left, even when a piece runs over the remaining weight', () => {
      expect(allocateLotCost({ remainingCost: 1000, remainingNet: 5, pieceNet: 6, isLastPiece: false })).toBe(1000);
    });
  });

  describe('PO bag line', () => {
    it('keeps the invoice amount exact, derives the bag totals from its category rows, and adds GST on top', async () => {
      const po = await createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [bagLine()] }, tenant.ctx, userId);
      poIds.push(po.id);
      const l = po.poItems[0];
      expect(Number(l.totalAmount)).toBe(100000);
      expect(Number(l.quantity)).toBe(1);
      expect(l.unit).toBe('BAG');
      expect(Number(l.weight)).toBe(60);
      expect(Number(l.netWeight)).toBe(54);          // 36 + 18
      expect(Number(l.taxRate)).toBeCloseTo(0.03);
      expect(Number(po.totalAmount)).toBeCloseTo(103000);

      // every category row is kept as the invoice states it; the missing weight is worked out
      const rows = [...l.categories].sort((a, b) => Number(b.grossWeight) - Number(a.grossWeight));
      expect(rows).toHaveLength(2);
      expect(rows[0].category.name).toBe('Rings');
      expect([Number(rows[0].grossWeight), Number(rows[0].stoneWeight), Number(rows[0].netWeight), rows[0].pieces]).toEqual([40, 4, 36, 4]);
      expect(rows[1].category.name).toBe('Necklaces');
      expect([Number(rows[1].grossWeight), Number(rows[1].stoneWeight), Number(rows[1].netWeight), rows[1].pieces]).toEqual([20, 2, 18, null]);
    });

    it('a plain line beside a bag line is unaffected', async () => {
      const po = await createPO({
        supplierId, poType: 'OUTRIGHT', orderDate: new Date(),
        items: [bagLine(), { materialCode: 'GOLD', materialName: 'Fine gold', materialType: 'METAL', quantity: 1, weight: 10, unit: 'GM', karat: '24K', ratePerUnit: 7000 }],
      }, tenant.ctx, userId);
      poIds.push(po.id);
      const gold = po.poItems.find((i) => i.materialType === 'METAL')!;
      expect(Number(gold.totalAmount)).toBe(7000);
      expect(gold.categories).toHaveLength(0);
      expect(Number(po.subtotal)).toBe(107000);
    });

    it('rejects a bag line that is incomplete, inconsistent or points outside the company', async () => {
      const bad = (extra: Record<string, unknown>) =>
        createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [bagLine(extra)] }, tenant.ctx, userId);
      await expect(bad({ categories: [] })).rejects.toThrow(/at least one category/);
      await expect(bad({ categories: undefined })).rejects.toThrow(/at least one category/);
      await expect(bad({ lotAmount: 0 })).rejects.toThrow(/lot amount/);
      await expect(bad({ categories: [ringRow({ netWeight: undefined }), neckRow()] })).rejects.toThrow(/net weight or the stone weight/);
      await expect(bad({ categories: [ringRow({ netWeight: 41 }), neckRow()] })).rejects.toThrow(/cannot exceed gross/);
      await expect(bad({ categories: [ringRow({ stoneWeight: 1 }), neckRow()] })).rejects.toThrow(/gross − stone must equal net/);
      await expect(bad({ categories: [ringRow({ karat: '99K' }), neckRow()] })).rejects.toThrow(/valid karat/);
      await expect(bad({ categories: [ringRow({ pieces: 0 }), neckRow()] })).rejects.toThrow(/pieces must be a whole number/);
      await expect(bad({ categories: [ringRow(), ringRow(), neckRow()] })).rejects.toThrow(/already in the lot/);
      // the categories must add up to the bag's gross weight
      await expect(bad({ weight: 80 })).rejects.toThrow(/add up to 60\.000 g but the bag's gross weight is 80\.000 g/);
      // a category from another company is a 404, not attached
      const other = await createTestTenant(`LOTC${suffix}`, ['po:create']);
      const foreign = await prisma.productCategory.create({ data: { companyId: other.company.id, code: `FC-${suffix}`, name: 'Foreign' } });
      try {
        await expect(bad({ categories: [ringRow({ categoryId: foreign.id }), neckRow()] })).rejects.toThrow(/not found/i);
      } finally {
        await prisma.productCategory.deleteMany({ where: { id: foreign.id } });
        await cleanupTestTenant(other);
      }
    });

    it('keeps the cost rates entered once per category (metal ₹/g, making ₹/g, VA %), and rejects nonsense', async () => {
      const po = await createPO({
        supplierId, poType: 'OUTRIGHT', orderDate: new Date(),
        items: [bagLine({ categories: [ringRow({ costRate: 5800, mcRate: 350, vaPercent: 8.5 }), neckRow()] })],
      }, tenant.ctx, userId);
      poIds.push(po.id);
      const rings = po.poItems[0].categories.find((c) => c.category.name === 'Rings')!;
      expect([Number(rings.costRate), Number(rings.mcRate), Number(rings.vaPercent)]).toEqual([5800, 350, 8.5]);
      const necks = po.poItems[0].categories.find((c) => c.category.name === 'Necklaces')!;
      expect([necks.costRate, necks.mcRate, necks.vaPercent]).toEqual([null, null, null]);   // all optional

      const bad = (extra: Record<string, unknown>) =>
        createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [bagLine({ categories: [ringRow(extra), neckRow()] })] }, tenant.ctx, userId);
      await expect(bad({ costRate: -1 })).rejects.toThrow(/metal cost rate/);
      await expect(bad({ mcRate: 'abc' })).rejects.toThrow(/making charge/);
      await expect(bad({ vaPercent: 101 })).rejects.toThrow(/value addition/);
    });

    it('the same category in two karats is two rows', async () => {
      const po = await createPO({
        supplierId, poType: 'OUTRIGHT', orderDate: new Date(),
        items: [bagLine({ weight: 60, categories: [ringRow({ grossWeight: 30, netWeight: 27 }), ringRow({ karat: '18K', grossWeight: 30, netWeight: 27 })] })],
      }, tenant.ctx, userId);
      poIds.push(po.id);
      expect(po.poItems[0].categories.map((c) => c.karat).sort()).toEqual(['18K', '22K']);
    });
  });

  describe('GRN receipt opens the lot and books the whole bill', () => {
    it('same-state supplier: lot opened, inventory + CGST/SGST debited, payable credited, supplier owed goods + GST', async () => {
      const before = await supplierDue(supplierId);
      const { lot, grn } = await receiveLot();

      expect(lot.pieces).toBeNull();                 // necklaces gave no count, so there is no bag total
      expect(Number(lot.grossWeight)).toBe(60);
      expect(Number(lot.netWeight)).toBe(54);
      expect(Number(lot.totalCost)).toBe(100000);
      expect(lot.karat).toBeNull();                  // karat lives on each category row
      expect(lot.status).toBe('OPEN');

      const entry = await getJournalEntry(lot.id);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INVENTORY).debit).toBeCloseTo(100000);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_CGST).debit).toBeCloseTo(1500);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_SGST).debit).toBeCloseTo(1500);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_PAYABLE).credit).toBeCloseTo(103000);

      const g = await prisma.grnItem.findUniqueOrThrow({ where: { id: grn.grnItems[0].id } });
      expect(Number(g.taxableValue)).toBe(100000);
      expect(Number(g.inputCgst)).toBeCloseTo(1500);
      expect((await supplierDue(supplierId)) - before).toBeCloseTo(103000);
    });

    it('a total piece count exists only when every category row states one', async () => {
      const { lot } = await receiveLot({ line: { categories: [ringRow(), neckRow({ pieces: 3 })] } });
      expect(lot.pieces).toBe(7);
    });

    it('other-state supplier books IGST instead', async () => {
      const { lot } = await receiveLot({ supplier: otherStateSupplierId });
      const entry = await getJournalEntry(lot.id);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_IGST).debit).toBeCloseTo(3000);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_CGST).debit).toBe(0);
    });

    it('a bag is received whole (one unit) and only once', async () => {
      const po = await createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [bagLine()] }, tenant.ctx, userId);
      poIds.push(po.id);
      const line = po.poItems[0];
      const receive = (qty: number) => createGRN({
        poId: po.id, receivedDate: new Date(), branchId,
        items: [{ poItemId: line.id, invoiceQty: qty, invoiceWeight: 60, scaleWeight: 60 }],
      }, tenant.ctx, userId);

      await expect(receive(2)).rejects.toThrow(/received whole/);
      const grn = await receive(1);
      lotIds.push((await prisma.purchaseLot.findUniqueOrThrow({ where: { grnItemId: grn.grnItems[0].id } })).id);
      await expect(receive(1)).rejects.toThrow(/already been received/);
      expect(await prisma.purchaseLot.count({ where: { grnItem: { poItemId: line.id } } })).toBe(1);
    });

    it('needs a receiving branch, like any finished goods', async () => {
      const po = await createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [bagLine()] }, tenant.ctx, userId);
      poIds.push(po.id);
      await expect(createGRN({
        poId: po.id, receivedDate: new Date(),
        items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 60, scaleWeight: 60 }],
      }, tenant.ctx, userId)).rejects.toThrow(/Receiving branch is required/);
    });
  });

  describe('tagging pieces out of a bag', () => {
    it('splits the whole bag by net weight across categories, the last piece takes the remainder, and the pieces add up to the invoice exactly', async () => {
      const { lot } = await receiveLot();
      const journalCount = () => prisma.journalEntry.count({ where: { companyId: tenant.company.id } });
      const entriesBefore = await journalCount();
      const dueBefore = await supplierDue(supplierId);

      // a ring first: 9 g of the bag's 54 g net -> 100000 x 9/54
      const r1 = await createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 10, netWeight: 9 });
      expect(Number(r1.costPrice)).toBe(16666.67);
      expect(r1.purchaseLotId).toBe(lot.id);
      // a necklace: 9 g of what is left (45 g net, ₹83,333.33) -> same rate per gram, not per category
      const n1 = await createTag({ purchaseLotId: lot.id, categoryId: neckCat, grossWeight: 10, netWeight: 9 });
      expect(Number(n1.costPrice)).toBe(16666.67);
      const rest = [
        await createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 10, netWeight: 9 }),
        await createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 10, netWeight: 9 }),
        await createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 10, netWeight: 9 }),
      ];
      expect((await prisma.purchaseLot.findUniqueOrThrow({ where: { id: lot.id } })).status).toBe('OPEN');   // 45 of 54 g

      // the piece that brings the tagged net weight up to the bag's takes whatever is left, and closes it
      const last = await createTag({ purchaseLotId: lot.id, categoryId: neckCat, grossWeight: 10, netWeight: 9 });
      const all = [r1, n1, ...rest, last];
      expect(all.reduce((s, t) => s + Number(t.costPrice), 0)).toBeCloseTo(100000, 2);
      const done = await prisma.purchaseLot.findUniqueOrThrow({ where: { id: lot.id } });
      expect(done.status).toBe('CLOSED');
      expect(done.closeNote).toBe('All pieces tagged');

      // Tagging moves no money: the bill was booked at receipt.
      expect(await journalCount()).toBe(entriesBefore);
      expect(await supplierDue(supplierId)).toBeCloseTo(dueBefore);
      expect(r1.status).toBe('IN_STOCK');
      expect(r1.branchId).toBe(branchId);
    });

    it('a category that stated a piece count stops at it; one that did not is limited by weight only', async () => {
      const { lot } = await receiveLot({ line: { categories: [ringRow({ grossWeight: 40, netWeight: 36, pieces: 2 }), neckRow()] } });
      await createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 10, netWeight: 9 });
      await createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 10, netWeight: 9 });
      await expect(createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 5, netWeight: 4 })).rejects.toThrow(/All 2 Rings 22K pieces of this lot are already tagged/);
      // necklaces: any number of pieces, as long as the weight is there
      for (let i = 0; i < 4; i++) await createTag({ purchaseLotId: lot.id, categoryId: neckCat, grossWeight: 4, netWeight: 3.5 });
      expect(await prisma.jewelryTag.count({ where: { purchaseLotId: lot.id, categoryId: neckCat } })).toBe(4);
    });

    it('a piece must be in a category the bag holds', async () => {
      const { lot } = await receiveLot();
      await expect(createTag({ purchaseLotId: lot.id, categoryId: otherCat })).rejects.toThrow(/no such category — it holds: Necklaces 22K, Rings 22K/);
      expect(await prisma.jewelryTag.count({ where: { purchaseLotId: lot.id } })).toBe(0);
    });

    it("a category's karat is its own: the piece must match it, and takes it when none is given", async () => {
      const { lot } = await receiveLot({
        line: { categories: [ringRow({ karat: '22K', grossWeight: 30, netWeight: 27 }), neckRow({ karat: '18K', grossWeight: 30, stoneWeight: 3 })] },
      });
      await expect(createTag({ purchaseLotId: lot.id, categoryId: neckCat, metalKarat: '22K' })).rejects.toThrow(/Necklaces in this lot is 18K/);
      const t = await createTag({ purchaseLotId: lot.id, categoryId: neckCat, metalKarat: undefined });
      expect(t.metalKarat).toBe('18K');
    });

    it('the same category in two karats needs the karat to say which row', async () => {
      const { lot } = await receiveLot({
        line: { categories: [ringRow({ grossWeight: 30, netWeight: 27 }), ringRow({ karat: '18K', grossWeight: 30, netWeight: 27 })] },
      });
      await expect(createTag({ purchaseLotId: lot.id, categoryId: ringCat, metalKarat: undefined })).rejects.toThrow(/more than one karat/);
      const t = await createTag({ purchaseLotId: lot.id, categoryId: ringCat, metalKarat: '18K' });
      expect(t.metalKarat).toBe('18K');
    });

    it("refuses weight beyond a category's row, but allows the 0.5% scale tolerance", async () => {
      const { lot } = await receiveLot();
      // rings are 36 g net on the invoice: 37 g is over even though the bag as a whole (54 g) has room
      await expect(createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 38, netWeight: 37 })).rejects.toThrow(/Net weight would exceed Rings 22K in this lot/);
      await expect(createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 41, netWeight: 30 })).rejects.toThrow(/Gross weight would exceed Rings 22K/);
      const t = await createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 40.1, netWeight: 36.1 });
      expect(Number(t.costPrice)).toBeLessThanOrEqual(100000);
    });

    it("takes the cost the tag builds (from the PO's rates, editable per tag), and only falls back to the bag split when none is given", async () => {
      const { lot } = await receiveLot();
      const t = await createTag({ purchaseLotId: lot.id, categoryId: ringCat, costPrice: 17000 });
      expect(Number(t.costPrice)).toBe(17000);
      // nothing entered -> the split of what is left of the bag by net weight: (100000 - 17000) x 9/45
      const fallback = await createTag({ purchaseLotId: lot.id, categoryId: ringCat });
      expect(Number(fallback.costPrice)).toBe(16600);
      // a tag's cost stays editable afterwards, like any tag's
      const edited = await updateTag(t.id, { name: 'Renamed', costPrice: 17500 }, tenant.ctx, userId);
      expect(edited.name).toBe('Renamed');
      expect(Number(edited.costPrice)).toBe(17500);
    });

    it('needs gross and net weight (cost is split by net), and net can not exceed gross', async () => {
      const { lot } = await receiveLot();
      await expect(createTag({ purchaseLotId: lot.id, grossWeight: 10, netWeight: 0 })).rejects.toThrow(/weight are required/);
      await expect(createTag({ purchaseLotId: lot.id, grossWeight: 5, netWeight: 6 })).rejects.toThrow(/cannot exceed gross/);
    });

    it('a failed tag leaves the lot untouched (all-or-nothing)', async () => {
      const { lot } = await receiveLot();
      await expect(createTag({ purchaseLotId: lot.id, categoryId: 'nope' })).rejects.toThrow();
      expect(await prisma.jewelryTag.count({ where: { purchaseLotId: lot.id } })).toBe(0);
    });

    it('two pieces tagged at once never share the same remainder', async () => {
      const { lot } = await receiveLot({ line: { weight: 20, lotAmount: 30000, categories: [ringRow({ grossWeight: 20, netWeight: 20, pieces: 2 })] } });
      const results = await Promise.allSettled([
        createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 10, netWeight: 10 }),
        createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 10, netWeight: 10 }),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const tags = await prisma.jewelryTag.findMany({ where: { purchaseLotId: lot.id } });
      expect(tags).toHaveLength(2);
      expect(tags.reduce((s, t) => s + Number(t.costPrice), 0)).toBeCloseTo(30000, 2);
      expect(tags.map((t) => Number(t.costPrice)).sort()).toEqual([15000, 15000]);
    });

    it("another company's lot is a 404 — it cannot be tagged from", async () => {
      const { lot } = await receiveLot();
      const other = await createTestTenant(`LOTX${suffix}`, ['tag:create']);
      const st = await prisma.stockType.create({ data: { companyId: other.company.id, code: `X${suffix}`.slice(0, 8).toUpperCase(), name: 'X' } });
      const cat = await prisma.productCategory.create({ data: { companyId: other.company.id, code: `XCAT-${suffix}`, name: 'X' } });
      try {
        await expect(_createTag(other.ctx, {
          branchId: other.branch.id, name: 'x', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 9,
          stockTypeId: st.id, categoryId: cat.id, purchaseLotId: lot.id,
        }, other.user.id)).rejects.toThrow(/not found/i);
        await expect(getPurchaseLot(other.ctx, lot.id)).rejects.toThrow(/not found/i);
        expect((await listPurchaseLots(other.ctx)).find((l) => l.id === lot.id)).toBeUndefined();
      } finally {
        await prisma.stockType.deleteMany({ where: { id: st.id } });
        await prisma.productCategory.deleteMany({ where: { id: cat.id } });
        await prisma.auditLog.deleteMany({ where: { userId: other.user.id } });
        await cleanupTestTenant(other);
      }
    });
  });

  describe('lot view and closing', () => {
    it('shows what is tagged and what is left, per category; closing reports the variance and stops further tagging', async () => {
      const { lot } = await receiveLot();
      await createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 10, netWeight: 9 });

      const open = await getPurchaseLot(tenant.ctx, lot.id);
      expect(open.pieces).toBeNull();
      expect(open.remainingPieces).toBeNull();
      expect(open.taggedPieces).toBe(1);
      expect(open.remainingNet).toBeCloseTo(45);
      expect(open.allocatedCost).toBe(16666.67);
      expect(open.remainingCost).toBe(83333.33);
      expect(open.supplier.name).toBe('Lot Supplier');
      expect(open.tags).toHaveLength(1);

      const rings = open.categories.find((c) => c.categoryName === 'Rings')!;
      expect([rings.pieces, rings.taggedPieces, rings.remainingPieces]).toEqual([4, 1, 3]);
      expect(rings.remainingNet).toBeCloseTo(27);
      const necks = open.categories.find((c) => c.categoryName === 'Necklaces')!;
      expect([necks.pieces, necks.taggedPieces, necks.remainingPieces]).toEqual([null, 0, null]);   // no count -> weights only
      expect(necks.netWeight).toBe(18);
      expect(necks.stoneWeight).toBe(2);
      expect((await listPurchaseLots(tenant.ctx, { status: 'OPEN' })).some((l) => l.id === lot.id)).toBe(true);

      const closed = await closePurchaseLot(tenant.ctx, lot.id, userId, 'Bag short');
      expect(closed.status).toBe('CLOSED');
      expect(closed.closeNote).toBe('Bag short');
      expect(closed.remainingNet).toBeCloseTo(45);   // the variance is reported, never silently written off
      expect(closed.remainingCost).toBe(83333.33);
      expect((await prisma.jewelryTag.findMany({ where: { purchaseLotId: lot.id } })).every((t) => t.status === 'IN_STOCK')).toBe(true);

      await expect(createTag({ purchaseLotId: lot.id, categoryId: ringCat })).rejects.toThrow(/is closed/);
      await expect(closePurchaseLot(tenant.ctx, lot.id, userId)).rejects.toThrow(/already closed/);
      expect((await listPurchaseLots(tenant.ctx, { status: 'OPEN' })).some((l) => l.id === lot.id)).toBe(false);
    });
  });

  describe('cost variance', () => {
    it("shows the rates New Tag pre-fills, and reports the gap between what the pieces carry and the invoice", async () => {
      const { lot } = await receiveLot({
        line: { weight: 20, lotAmount: 30000, categories: [ringRow({ grossWeight: 20, netWeight: 18, pieces: 2, costRate: 1500, mcRate: 100, vaPercent: 5 })] },
      });
      const before = await getPurchaseLot(tenant.ctx, lot.id);
      expect(before.categories[0]).toMatchObject({ costRate: 1500, mcRate: 100, vaPercent: 5 });

      await createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 10, netWeight: 9, costPrice: 14000 });
      await createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 10, netWeight: 9, costPrice: 15500 });
      const after = await getPurchaseLot(tenant.ctx, lot.id);
      expect(after.status).toBe('CLOSED');           // the last piece still closes the bag
      expect(after.allocatedCost).toBe(29500);
      expect(after.costVariance).toBe(500);          // the pieces carry ₹500 less than the invoice
    });
  });

  describe('purchase return of a piece cut from a bag', () => {
    it('is returnable, and reverses its allocated cost plus the GST booked on the bag, pro-rata', async () => {
      const { lot } = await receiveLot();
      const t = await createTag({ purchaseLotId: lot.id, categoryId: ringCat, grossWeight: 10, netWeight: 9 });   // ₹16,666.67 of 1,00,000

      expect((await listReturnableTags(tenant.ctx, supplierId)).some((x) => x.id === t.id)).toBe(true);

      const dueBefore = await supplierDue(supplierId);
      const ret = await createPurchaseReturn({ items: [{ tagId: t.id }], reason: 'Defective' }, tenant.ctx, userId);
      returnIds.push(ret.id);

      expect(Number(ret.totalAmount)).toBe(16666.67);
      expect(Number(ret.taxAmount)).toBeCloseTo(500);            // 3% of 16,666.67
      const entry = await getJournalEntry(ret.id);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_PAYABLE).debit).toBeCloseTo(17166.67);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INVENTORY).credit).toBeCloseTo(16666.67);
      expect(dueBefore - (await supplierDue(supplierId))).toBeCloseTo(17166.67);
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('RETIRED');
    });
  });

  describe('reports read a bag like any other purchase', () => {
    it('supplier ledger shows the bag bill, and the purchase-GST summary counts it (net of a bag-piece return)', async () => {
      const t2 = await createTestTenant(`LOTR${suffix}`, ['po:create', 'grn:create', 'tag:create', 'po:approve']);
      const st = await prisma.stockType.create({ data: { companyId: t2.company.id, code: `R${suffix}`.slice(0, 8).toUpperCase(), name: 'R' } });
      const cat = await prisma.productCategory.create({ data: { companyId: t2.company.id, code: `RCAT-${suffix}`, name: 'R' } });
      const sup = await prisma.supplier.create({
        data: { companyId: t2.company.id, supplierCode: `LOTRS-${suffix}`, name: 'Report Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z5' },
      });
      const localPo: string[] = [], localLots: string[] = [], localTags: string[] = [], localReturns: string[] = [];
      try {
        const po = await createPO({
          supplierId: sup.id, poType: 'OUTRIGHT', orderDate: new Date(),
          items: [bagLine({ weight: 40, categories: [{ categoryId: cat.id, karat: '22K', grossWeight: 40, netWeight: 36, pieces: 4 }] })],
        }, t2.ctx, t2.user.id);
        localPo.push(po.id);
        const grn = await createGRN({
          poId: po.id, receivedDate: new Date(), branchId: t2.branch.id, invoiceNumber: 'LOT-BILL-1', invoiceDate: new Date(),
          items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 40, scaleWeight: 40 }],
        }, t2.ctx, t2.user.id);
        const lot = await prisma.purchaseLot.findUniqueOrThrow({ where: { grnItemId: grn.grnItems[0].id } });
        localLots.push(lot.id);
        const tag = await _createTag(t2.ctx, {
          branchId: t2.branch.id, name: 'r', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 9,
          stockTypeId: st.id, categoryId: cat.id, purchaseLotId: lot.id,
        }, t2.user.id);
        localTags.push(tag.id);
        const ret = await createPurchaseReturn({ items: [{ tagId: tag.id }] }, t2.ctx, t2.user.id);
        localReturns.push(ret.id);

        const ledger = await getSupplierLedger(t2.ctx, sup.id);
        expect(ledger.rows.map((r) => r.type)).toEqual(['PURCHASE', 'RETURN']);
        expect(ledger.rows[0].credit).toBeCloseTo(103000);
        expect(ledger.rows[0].description).toMatch(/lot 22K Gold Bag/);
        expect(ledger.closingBalance).toBeCloseTo(103000 - Number(ret.totalAmount) - Number(ret.taxAmount));
        expect(ledger.closingBalance).toBeCloseTo(ledger.supplier.currentDue);

        const summary = await getPurchaseGstSummary(t2.company.id, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
        expect(summary.rows).toHaveLength(1);
        expect(summary.rows[0].hsnCode).toBe('7113');
        expect(summary.totals.taxableValue).toBeCloseTo(100000 - Number(ret.totalAmount));
        expect(summary.totals.totalTax).toBeCloseTo(3000 - Number(ret.taxAmount));
        expect(summary.bills).toHaveLength(1);
        expect(summary.bills[0].invoiceNumber).toBe('LOT-BILL-1');
      } finally {
        await cleanupJournalEntries([...localLots, ...localReturns]);
        await prisma.purchaseReturn.deleteMany({ where: { id: { in: localReturns } } });
        await prisma.jewelryTag.deleteMany({ where: { id: { in: localTags } } });
        await prisma.purchaseLot.deleteMany({ where: { id: { in: localLots } } });
        await prisma.auditLog.deleteMany({ where: { userId: t2.user.id } });
        await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: localPo } } });
        await prisma.purchaseOrder.deleteMany({ where: { id: { in: localPo } } });
        await prisma.supplier.deleteMany({ where: { id: sup.id } });
        await prisma.stockType.deleteMany({ where: { id: st.id } });
        await prisma.productCategory.deleteMany({ where: { id: cat.id } });
        await cleanupTestTenant(t2);
      }
    });
  });
});
