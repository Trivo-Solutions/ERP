import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext, assertOwnedByCompany, assertOwnedIfPresent } from '../../middleware/tenant';
import { tenantQuery, tenantTransaction } from '../../shared/tenantContext';
import { isBlockedByForeignKey } from '../../shared/prismaErrors';
import { AppError } from '../../middleware/error';
import { assertPricingMode } from '../../shared/fixedPrice';
import { createAuditEntry } from '../../middleware/audit';
import {
  listSubCategories, listCategoriesForSubCategory, createSubCategory, updateSubCategory,
  linkSubCategory, unlinkSubCategory, deleteSubCategory,
} from './subCategory.service';

export const mastersRouter = Router();
// Every master below is company-owned (Phase 1 of full company isolation): each company has its
// own independent list, and every read/write here is pinned to req.tenant.companyId. Nothing in
// this router touches another company's rows — a wrong-company id is a 404, exactly like a
// nonexistent one. (HsnCode/StateMaster are read-only platform reference data and have no route
// here at all.)
mastersRouter.use(authenticate, resolveTenantContext);

// PATCH bodies are whitelisted per resource, never passed to Prisma as-is — a client must not be
// able to change companyId/id/createdAt (or any column not meant to be editable) through a PATCH.
function pick(body: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

// code is always stored upper-case (it's a business code, and the per-company unique key).
function withUpperCode<T extends Record<string, unknown>>(data: T): T {
  return typeof data.code === 'string' ? { ...data, code: data.code.toUpperCase() } : data;
}

// DELETE for a master row. A master is only removable while nothing references it: every FK from
// tags/invoices/rates back to a master is ON DELETE RESTRICT, so the database itself refuses (P2003)
// and history is never touched. An in-use row is turned into a clear 409 — deactivate it instead.
async function deleteUnusedMaster(companyId: string, label: string, remove: Parameters<typeof tenantQuery<unknown>>[1]) {
  try {
    await tenantQuery(companyId, remove);
  } catch (err) {
    if (isBlockedByForeignKey(err)) {
      throw new AppError(`${label} is in use and cannot be deleted. Deactivate it instead.`, 409);
    }
    throw err;
  }
}

// ─── Stock Types (how a piece is held — Ready/Approval/Karigar stock, etc.) ────
// Code is meant to be short (a single letter is the common case) — it becomes the first
// segment of a tag number (see shared/numberSequence.ts: nextTagNumber).

const STOCK_TYPE_FIELDS = ['code', 'name', 'description', 'isActive'] as const;

mastersRouter.get('/stock-types', requirePermission('masters:view'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = await tenantQuery(companyId, (tx) =>
    tx.stockType.findMany({ where: { companyId, isActive: true }, orderBy: { name: 'asc' } })
  );
  res.json({ success: true, data });
});

mastersRouter.post('/stock-types', requirePermission('masters:create'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = withUpperCode(pick(req.body, STOCK_TYPE_FIELDS)) as { code: string; name: string };
  const item = await tenantQuery(companyId, (tx) => tx.stockType.create({ data: { ...data, companyId } }));
  res.status(201).json({ success: true, data: item });
});

mastersRouter.patch('/stock-types/:id', requirePermission('masters:edit'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('stockType', req.params.id, companyId, 'Stock type');
  const item = await tenantQuery(companyId, (tx) =>
    tx.stockType.update({ where: { id: req.params.id }, data: withUpperCode(pick(req.body, STOCK_TYPE_FIELDS)) })
  );
  res.json({ success: true, data: item });
});

mastersRouter.delete('/stock-types/:id', requirePermission('masters:delete'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('stockType', req.params.id, companyId, 'Stock type');
  await deleteUnusedMaster(companyId, 'This stock type', (tx) => tx.stockType.delete({ where: { id: req.params.id } }));
  res.json({ success: true, message: 'Stock type deleted' });
});

// ─── Product Categories ────────────────────────────────────────────────────────

const CATEGORY_FIELDS = ['code', 'name', 'isActive', 'pricingMode'] as const;

mastersRouter.get('/categories', requirePermission('masters:view'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = await tenantQuery(companyId, (tx) =>
    tx.productCategory.findMany({
      where: { companyId },
      include: { _count: { select: { subCategoryLinks: true } } },
      orderBy: { name: 'asc' },
    })
  );
  res.json({ success: true, data });
});

mastersRouter.post('/categories', requirePermission('masters:create'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const { code, name } = req.body;
  const pricingMode = req.body.pricingMode === undefined ? 'WEIGHT_BASED' : assertPricingMode(req.body.pricingMode);
  const item = await tenantQuery(companyId, (tx) =>
    tx.productCategory.create({ data: { companyId, code: String(code).toUpperCase(), name, pricingMode } })
  );
  res.status(201).json({ success: true, data: item });
});

mastersRouter.patch('/categories/:id', requirePermission('masters:edit'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('productCategory', req.params.id, companyId, 'Category');
  if (req.body.pricingMode !== undefined) assertPricingMode(req.body.pricingMode);
  const prior = await tenantQuery(companyId, (tx) => tx.productCategory.findFirst({ where: { id: req.params.id, companyId }, select: { pricingMode: true } }));
  const item = await tenantQuery(companyId, (tx) =>
    tx.productCategory.update({ where: { id: req.params.id }, data: withUpperCode(pick(req.body, CATEGORY_FIELDS)) })
  );
  // Switching the mode only affects tags created from now on (each tag snapshots the mode when it is tagged) - audited.
  if (prior && prior.pricingMode !== item.pricingMode) {
    await createAuditEntry('product_categories', item.id, req.user!.userId, 'EDIT', { pricingMode: prior.pricingMode }, { pricingMode: item.pricingMode }, companyId);
  }
  res.json({ success: true, data: item });
});

mastersRouter.delete('/categories/:id', requirePermission('masters:delete'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('productCategory', req.params.id, companyId, 'Category');
  await deleteUnusedMaster(companyId, 'This category', (tx) => tx.productCategory.delete({ where: { id: req.params.id } }));
  res.json({ success: true, message: 'Category deleted' });
});

// ─── Sub-categories ───────────────────────────────────────────────────────────

// A sub-category is ONE company master linked to many categories (CategorySubCategory) — see
// subCategory.service.ts. ?categoryId= lists only the sub-categories linked to that category (what the
// New Tag / GRN pickers use); ?search= matches code or name; ?active=true hides deactivated rows.

mastersRouter.get('/subcategories', requirePermission('masters:view'), async (req: Request, res: Response) => {
  const q = req.query;
  const data = await listSubCategories(req.tenant!.companyId, {
    categoryId: typeof q.categoryId === 'string' && q.categoryId ? q.categoryId : undefined,
    search: typeof q.search === 'string' ? q.search : undefined,
    activeOnly: q.active === 'true',
  });
  res.json({ success: true, data });
});

mastersRouter.post('/subcategories', requirePermission('masters:create'), async (req: Request, res: Response) => {
  const item = await createSubCategory(req.tenant!.companyId, req.body ?? {}, req.user!.userId);
  res.status(201).json({ success: true, data: item });
});

mastersRouter.patch('/subcategories/:id', requirePermission('masters:edit'), async (req: Request, res: Response) => {
  const item = await updateSubCategory(req.tenant!.companyId, req.params.id, req.body ?? {}, req.user!.userId);
  res.json({ success: true, data: item });
});

mastersRouter.delete('/subcategories/:id', requirePermission('masters:delete'), async (req: Request, res: Response) => {
  await deleteSubCategory(req.tenant!.companyId, req.params.id, req.user!.userId);
  res.json({ success: true, message: 'Sub-category deleted' });
});

mastersRouter.get('/subcategories/:id/categories', requirePermission('masters:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await listCategoriesForSubCategory(req.tenant!.companyId, req.params.id) });
});

// Link an EXISTING sub-category to another category (no new sub-category row is ever created here).
mastersRouter.post('/subcategories/:id/categories', requirePermission('masters:edit'), async (req: Request, res: Response) => {
  const data = await linkSubCategory(req.tenant!.companyId, req.params.id, req.body?.categoryId, req.user!.userId);
  res.status(201).json({ success: true, data });
});

mastersRouter.delete('/subcategories/:id/categories/:categoryId', requirePermission('masters:edit'), async (req: Request, res: Response) => {
  const data = await unlinkSubCategory(req.tenant!.companyId, req.params.id, req.params.categoryId, req.user!.userId);
  res.json({ success: true, data });
});

// ─── Setting types (prong, bezel, pave ...) ───────────────────────────────────
// Offered on New Tag. JewelryTag.settingType stays free text (the chosen name), so deactivating or
// renaming a row here never rewrites an existing tag.

const SETTING_TYPE_FIELDS = ['code', 'name', 'isActive'] as const;

mastersRouter.get('/setting-types', requirePermission('masters:view'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = await tenantQuery(companyId, (tx) =>
    tx.settingType.findMany({
      where: { companyId, ...(req.query.active === 'true' && { isActive: true }) },
      orderBy: { name: 'asc' },
    })
  );
  res.json({ success: true, data });
});

mastersRouter.post('/setting-types', requirePermission('masters:create'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = withUpperCode(pick(req.body, SETTING_TYPE_FIELDS)) as { code: string; name: string };
  const item = await tenantQuery(companyId, (tx) => tx.settingType.create({ data: { ...data, companyId } }));
  res.status(201).json({ success: true, data: item });
});

mastersRouter.patch('/setting-types/:id', requirePermission('masters:edit'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('settingType', req.params.id, companyId, 'Setting type');
  const item = await tenantQuery(companyId, (tx) =>
    tx.settingType.update({ where: { id: req.params.id }, data: withUpperCode(pick(req.body, SETTING_TYPE_FIELDS)) })
  );
  res.json({ success: true, data: item });
});

mastersRouter.delete('/setting-types/:id', requirePermission('masters:delete'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('settingType', req.params.id, companyId, 'Setting type');
  await deleteUnusedMaster(companyId, 'This setting type', (tx) => tx.settingType.delete({ where: { id: req.params.id } }));
  res.json({ success: true, message: 'Setting type deleted' });
});

// ─── Collections ──────────────────────────────────────────────────────────────

const COLLECTION_FIELDS = ['code', 'name', 'description', 'isActive'] as const;

mastersRouter.get('/collections', requirePermission('masters:view'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = await tenantQuery(companyId, (tx) =>
    tx.collection.findMany({ where: { companyId }, orderBy: { name: 'asc' } })
  );
  res.json({ success: true, data });
});

mastersRouter.post('/collections', requirePermission('masters:create'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = withUpperCode(pick(req.body, COLLECTION_FIELDS)) as { code: string; name: string };
  const item = await tenantQuery(companyId, (tx) => tx.collection.create({ data: { ...data, companyId } }));
  res.status(201).json({ success: true, data: item });
});

mastersRouter.patch('/collections/:id', requirePermission('masters:edit'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('collection', req.params.id, companyId, 'Collection');
  const item = await tenantQuery(companyId, (tx) =>
    tx.collection.update({ where: { id: req.params.id }, data: withUpperCode(pick(req.body, COLLECTION_FIELDS)) })
  );
  res.json({ success: true, data: item });
});

mastersRouter.delete('/collections/:id', requirePermission('masters:delete'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('collection', req.params.id, companyId, 'Collection');
  await deleteUnusedMaster(companyId, 'This collection', (tx) => tx.collection.delete({ where: { id: req.params.id } }));
  res.json({ success: true, message: 'Collection deleted' });
});

// ─── Sizes (ring size, bangle size, chain length ...) ─────────────────────────
// categoryId is optional: set, the size is offered only for that category on New Tag; unset, for
// every category. `?active=true` (New Tag) hides deactivated rows; `?categoryId=` returns that
// category's sizes plus the category-less ones.

const SIZE_FIELDS = ['code', 'name', 'categoryId', 'isActive'] as const;

mastersRouter.get('/sizes', requirePermission('masters:view'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const categoryId = typeof req.query.categoryId === 'string' && req.query.categoryId ? req.query.categoryId : undefined;
  const data = await tenantQuery(companyId, (tx) =>
    tx.size.findMany({
      where: {
        companyId,
        ...(req.query.active === 'true' && { isActive: true }),
        ...(categoryId && { OR: [{ categoryId }, { categoryId: null }] }),
      },
      include: { category: { select: { name: true, code: true } } },
      orderBy: { name: 'asc' },
    })
  );
  res.json({ success: true, data });
});

mastersRouter.post('/sizes', requirePermission('masters:create'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const body = { ...req.body, categoryId: req.body.categoryId || null };
  await assertOwnedIfPresent('productCategory', body.categoryId, companyId, 'Category');
  const data = withUpperCode(pick(body, SIZE_FIELDS)) as { code: string; name: string };
  const item = await tenantQuery(companyId, (tx) => tx.size.create({ data: { ...data, companyId } }));
  res.status(201).json({ success: true, data: item });
});

mastersRouter.patch('/sizes/:id', requirePermission('masters:edit'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('size', req.params.id, companyId, 'Size');
  const body = req.body.categoryId === '' ? { ...req.body, categoryId: null } : req.body;
  await assertOwnedIfPresent('productCategory', body.categoryId, companyId, 'Category');
  const item = await tenantQuery(companyId, (tx) =>
    tx.size.update({ where: { id: req.params.id }, data: withUpperCode(pick(body, SIZE_FIELDS)) })
  );
  res.json({ success: true, data: item });
});

mastersRouter.delete('/sizes/:id', requirePermission('masters:delete'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('size', req.params.id, companyId, 'Size');
  await deleteUnusedMaster(companyId, 'This size', (tx) => tx.size.delete({ where: { id: req.params.id } }));
  res.json({ success: true, message: 'Size deleted' });
});

// ─── Material Codes ───────────────────────────────────────────────────────────

const MATERIAL_CODE_FIELDS = ['code', 'name', 'materialType', 'karat', 'unit', 'description', 'isActive'] as const;

mastersRouter.get('/material-codes', requirePermission('masters:view'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = await tenantQuery(companyId, (tx) =>
    tx.materialCode.findMany({
      where: { companyId, ...(req.query.materialType && { materialType: req.query.materialType as string }) },
      orderBy: [{ materialType: 'asc' }, { code: 'asc' }],
    })
  );
  res.json({ success: true, data });
});

mastersRouter.post('/material-codes', requirePermission('masters:create'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = withUpperCode(pick(req.body, MATERIAL_CODE_FIELDS)) as { code: string; name: string; materialType: string };
  const item = await tenantQuery(companyId, (tx) => tx.materialCode.create({ data: { ...data, companyId } }));
  res.status(201).json({ success: true, data: item });
});

mastersRouter.patch('/material-codes/:id', requirePermission('masters:edit'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('materialCode', req.params.id, companyId, 'Material code');
  const item = await tenantQuery(companyId, (tx) =>
    tx.materialCode.update({ where: { id: req.params.id }, data: withUpperCode(pick(req.body, MATERIAL_CODE_FIELDS)) })
  );
  res.json({ success: true, data: item });
});

mastersRouter.delete('/material-codes/:id', requirePermission('masters:delete'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('materialCode', req.params.id, companyId, 'Material code');
  await deleteUnusedMaster(companyId, 'This material code', (tx) => tx.materialCode.delete({ where: { id: req.params.id } }));
  res.json({ success: true, message: 'Material code deleted' });
});

// ─── Karat / Purity Master ────────────────────────────────────────────────────

const KARAT_FIELDS = ['code', 'metalType', 'purity', 'isActive'] as const;

mastersRouter.get('/karats', requirePermission('masters:view'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = await tenantQuery(companyId, (tx) =>
    // Dropdowns want active karats only; the Masters page passes includeInactive so a removed
    // (deactivated) karat stays visible there and can be re-activated.
    tx.karatMaster.findMany({
      where: { companyId, ...(req.query.includeInactive === 'true' ? {} : { isActive: true }) },
      orderBy: { code: 'asc' },
    })
  );
  res.json({ success: true, data });
});

mastersRouter.post('/karats', requirePermission('masters:create'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = withUpperCode(pick(req.body, KARAT_FIELDS)) as { code: string; metalType: string; purity: string };
  const item = await tenantQuery(companyId, (tx) => tx.karatMaster.create({ data: { ...data, companyId } }));
  res.status(201).json({ success: true, data: item });
});

mastersRouter.patch('/karats/:id', requirePermission('masters:edit'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('karatMaster', req.params.id, companyId, 'Karat');
  const item = await tenantQuery(companyId, (tx) =>
    tx.karatMaster.update({ where: { id: req.params.id }, data: withUpperCode(pick(req.body, KARAT_FIELDS)) })
  );
  res.json({ success: true, data: item });
});

mastersRouter.delete('/karats/:id', requirePermission('masters:delete'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('karatMaster', req.params.id, companyId, 'Karat');
  // Tags, rates, POs, invoices and making charges hold the karat as plain text (no FK), so the database
  // can't guard it — check the usage here.
  const used = await tenantTransaction(companyId, async (tx) => {
    const { code } = await tx.karatMaster.findUniqueOrThrow({ where: { id: req.params.id } });
    const counts = await Promise.all([
      tx.jewelryTag.count({ where: { companyId, metalKarat: code } }),
      tx.makingCharge.count({ where: { companyId, karat: code } }),
      tx.materialCode.count({ where: { companyId, karat: code } }),
      tx.metalRate.count({ where: { companyId, karat: code } }),
      tx.poItem.count({ where: { companyId, karat: code } }),
      tx.poItemCategory.count({ where: { companyId, karat: code } }),
      tx.invoiceItem.count({ where: { companyId, karat: code } }),
      tx.memoItem.count({ where: { companyId, karat: code } }),
      tx.purchaseLot.count({ where: { companyId, karat: code } }),
    ]);
    return counts.reduce((a, b) => a + b, 0);
  });
  if (used > 0) throw new AppError('This karat is in use and cannot be deleted. Deactivate it instead.', 409);
  await deleteUnusedMaster(companyId, 'This karat', (tx) => tx.karatMaster.delete({ where: { id: req.params.id } }));
  res.json({ success: true, message: 'Karat deleted' });
});

// ─── Stone Types ──────────────────────────────────────────────────────────────

const STONE_TYPE_FIELDS = ['code', 'name', 'itemType', 'unit', 'description', 'isActive'] as const;

mastersRouter.get('/stone-types', requirePermission('masters:view'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = await tenantQuery(companyId, (tx) =>
    tx.stoneType.findMany({ where: { companyId }, orderBy: { name: 'asc' } })
  );
  res.json({ success: true, data });
});

mastersRouter.post('/stone-types', requirePermission('masters:create'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = withUpperCode(pick(req.body, STONE_TYPE_FIELDS)) as { code: string; name: string };
  const item = await tenantQuery(companyId, (tx) => tx.stoneType.create({ data: { ...data, companyId } }));
  res.status(201).json({ success: true, data: item });
});

mastersRouter.patch('/stone-types/:id', requirePermission('masters:edit'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('stoneType', req.params.id, companyId, 'Stone type');
  const item = await tenantQuery(companyId, (tx) =>
    tx.stoneType.update({ where: { id: req.params.id }, data: withUpperCode(pick(req.body, STONE_TYPE_FIELDS)) })
  );
  res.json({ success: true, data: item });
});

mastersRouter.delete('/stone-types/:id', requirePermission('masters:delete'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('stoneType', req.params.id, companyId, 'Stone type');
  await deleteUnusedMaster(companyId, 'This stone type', (tx) => tx.stoneType.delete({ where: { id: req.params.id } }));
  res.json({ success: true, message: 'Stone type deleted' });
});

// ─── Stone Grades (a reusable shape/color/clarity/cut, or quality, combination for a
// Stone Type — defined once, then referenced by any number of Price Master entries over
// time and by a tagged stone's valuation) ──────────────────────────────────────

const STONE_GRADE_FIELDS = ['stoneTypeId', 'shape', 'color', 'clarity', 'cut', 'quality', 'isActive'] as const;
const GRADE_INCLUDE = { stoneType: { select: { name: true, code: true, itemType: true, unit: true } } } as const;

mastersRouter.get('/stone-grades', requirePermission('masters:view'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = await tenantQuery(companyId, (tx) =>
    tx.stoneGrade.findMany({
      where: {
        companyId,
        isActive: true,
        ...(req.query.stoneTypeId && { stoneTypeId: req.query.stoneTypeId as string }),
      },
      include: GRADE_INCLUDE,
      orderBy: { createdAt: 'desc' },
    })
  );
  res.json({ success: true, data });
});

mastersRouter.post('/stone-grades', requirePermission('masters:create'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  // The parent stone type is a foreign id from the client — must be this company's own.
  await assertOwnedByCompany('stoneType', req.body.stoneTypeId, companyId, 'Stone type');
  const item = await tenantQuery(companyId, (tx) =>
    tx.stoneGrade.create({
      data: {
        companyId,
        stoneTypeId: req.body.stoneTypeId,
        shape: req.body.shape ?? null,
        color: req.body.color ?? null,
        clarity: req.body.clarity ?? null,
        cut: req.body.cut ?? null,
        quality: req.body.quality ?? null,
      },
      include: GRADE_INCLUDE,
    })
  );
  res.status(201).json({ success: true, data: item });
});

mastersRouter.patch('/stone-grades/:id', requirePermission('masters:edit'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('stoneGrade', req.params.id, companyId, 'Stone grade');
  await assertOwnedIfPresent('stoneType', req.body.stoneTypeId, companyId, 'Stone type');
  const item = await tenantQuery(companyId, (tx) =>
    tx.stoneGrade.update({ where: { id: req.params.id }, data: pick(req.body, STONE_GRADE_FIELDS) })
  );
  res.json({ success: true, data: item });
});

mastersRouter.delete('/stone-grades/:id', requirePermission('masters:delete'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('stoneGrade', req.params.id, companyId, 'Stone grade');
  await deleteUnusedMaster(companyId, 'This stone grade', (tx) => tx.stoneGrade.delete({ where: { id: req.params.id } }));
  res.json({ success: true, message: 'Stone grade deleted' });
});

// ─── Price Master ─────────────────────────────────────────────────────────────

const PRICE_MASTER_FIELDS = [
  'stoneGradeId', 'weightFrom', 'weightTo', 'pricePerCarat', 'priceUnit', 'effectiveDate', 'notes', 'isActive',
] as const;

// Optional Decimal columns (weightFrom/weightTo) reject '' — the client sends '' for
// fields hidden by the current itemType (e.g. weight slabs on a STONE entry) rather
// than omitting them, so normalize blanks to null before they reach Prisma.
function toDecimalOrNull(v: string | number | null | undefined): string | number | null {
  return v === '' || v === undefined ? null : v;
}

mastersRouter.get('/price-master', requirePermission('masters:view'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = await tenantQuery(companyId, (tx) =>
    tx.priceMaster.findMany({
      where: {
        companyId,
        isActive: true,
        ...(req.query.itemType && { itemType: req.query.itemType as string }),
      },
      include: { stoneGrade: { include: { stoneType: { select: { name: true, code: true } } } } },
      orderBy: [{ itemType: 'asc' }, { effectiveDate: 'desc' }],
    })
  );
  res.json({ success: true, data });
});

// Price Master only ever picks a Grade and sets a price — it never re-enters classification.
// itemType/shape/color/clarity/cut/quality are entirely derived from the referenced
// StoneGrade, never trusted from the request body (same "snapshot at write time" reasoning
// as the HSN taxRate snapshot on InvoiceItem: a later edit to a Grade can't silently
// reclassify historical pricing). The grade must be the caller's own company's.
async function snapshotGradeClassification(companyId: string, stoneGradeId: string) {
  await assertOwnedByCompany('stoneGrade', stoneGradeId, companyId, 'Stone grade');
  const grade = await tenantQuery(companyId, (tx) =>
    tx.stoneGrade.findUniqueOrThrow({
      where: { id: stoneGradeId },
      include: { stoneType: { select: { itemType: true } } },
    })
  );
  return {
    itemType: grade.stoneType.itemType,
    shape: grade.shape,
    color: grade.color,
    clarity: grade.clarity,
    cut: grade.cut,
    quality: grade.quality,
  };
}

mastersRouter.post('/price-master', requirePermission('masters:create'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const classification = await snapshotGradeClassification(companyId, req.body.stoneGradeId);
  const item = await tenantQuery(companyId, (tx) =>
    tx.priceMaster.create({
      data: {
        companyId,
        ...classification,
        stoneGradeId: req.body.stoneGradeId,
        weightFrom: toDecimalOrNull(req.body.weightFrom),
        weightTo: toDecimalOrNull(req.body.weightTo),
        pricePerCarat: req.body.pricePerCarat,
        priceUnit: req.body.priceUnit ?? 'PER_CARAT',
        effectiveDate: req.body.effectiveDate ? new Date(req.body.effectiveDate) : new Date(),
        notes: req.body.notes ?? null,
      },
      include: { stoneGrade: { include: { stoneType: { select: { name: true } } } } },
    })
  );
  res.status(201).json({ success: true, data: item });
});

mastersRouter.patch('/price-master/:id', requirePermission('masters:edit'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('priceMaster', req.params.id, companyId, 'Price master entry');
  const data = pick(req.body, PRICE_MASTER_FIELDS);
  if ('weightFrom' in data) data.weightFrom = toDecimalOrNull(data.weightFrom as string | number | null);
  if ('weightTo' in data) data.weightTo = toDecimalOrNull(data.weightTo as string | number | null);
  if (data.stoneGradeId) Object.assign(data, await snapshotGradeClassification(companyId, data.stoneGradeId as string));
  const item = await tenantQuery(companyId, (tx) => tx.priceMaster.update({ where: { id: req.params.id }, data }));
  res.json({ success: true, data: item });
});

mastersRouter.delete('/price-master/:id', requirePermission('masters:delete'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('priceMaster', req.params.id, companyId, 'Price master entry');
  await tenantQuery(companyId, (tx) => tx.priceMaster.update({ where: { id: req.params.id }, data: { isActive: false } }));
  res.json({ success: true, message: 'Price entry deactivated' });
});

// ─── Making Charges ───────────────────────────────────────────────────────────

const MAKING_CHARGE_FIELDS = [
  'materialCodeId', 'karat', 'categoryId', 'makeType', 'saleWastagePercent',
  'makingCharge', 'makingChargeType', 'effectiveDate', 'notes', 'isActive',
] as const;
const MAKING_CHARGE_INCLUDE = {
  materialCode: { select: { code: true, name: true, materialType: true, unit: true } },
  category: { select: { code: true, name: true } },
} as const;

mastersRouter.get('/making-charges', requirePermission('masters:view'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const data = await tenantQuery(companyId, (tx) =>
    tx.makingCharge.findMany({
      where: {
        companyId,
        isActive: true,
        ...(req.query.materialCodeId && { materialCodeId: req.query.materialCodeId as string }),
        ...(req.query.karat && { karat: req.query.karat as string }),
        ...(req.query.makeType && { makeType: req.query.makeType as string }),
      },
      include: MAKING_CHARGE_INCLUDE,
      orderBy: [{ makeType: 'asc' }, { karat: 'asc' }, { materialCode: { code: 'asc' } }, { effectiveDate: 'desc' }],
    })
  );
  res.json({ success: true, data });
});

mastersRouter.post('/making-charges', requirePermission('masters:create'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  // Both are foreign master ids from the client — must be this company's own.
  await assertOwnedIfPresent('materialCode', req.body.materialCodeId, companyId, 'Material code');
  await assertOwnedIfPresent('productCategory', req.body.categoryId, companyId, 'Category');
  const item = await tenantQuery(companyId, (tx) =>
    tx.makingCharge.create({
      data: {
        companyId,
        materialCodeId:    req.body.materialCodeId    ?? null,
        karat:             req.body.karat             ?? null,
        categoryId:        req.body.categoryId        ?? null,
        makeType:          req.body.makeType          ?? null,
        saleWastagePercent: req.body.saleWastagePercent ?? 0,
        makingCharge:      req.body.makingCharge      ?? 0,
        makingChargeType:  req.body.makingChargeType  ?? 'PER_GRAM',
        effectiveDate:     req.body.effectiveDate ? new Date(req.body.effectiveDate) : new Date(),
        notes:             req.body.notes             ?? null,
      },
      include: MAKING_CHARGE_INCLUDE,
    })
  );
  res.status(201).json({ success: true, data: item });
});

mastersRouter.patch('/making-charges/:id', requirePermission('masters:edit'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('makingCharge', req.params.id, companyId, 'Making charge entry');
  await assertOwnedIfPresent('materialCode', req.body.materialCodeId, companyId, 'Material code');
  await assertOwnedIfPresent('productCategory', req.body.categoryId, companyId, 'Category');
  const item = await tenantQuery(companyId, (tx) =>
    tx.makingCharge.update({ where: { id: req.params.id }, data: pick(req.body, MAKING_CHARGE_FIELDS) })
  );
  res.json({ success: true, data: item });
});

mastersRouter.delete('/making-charges/:id', requirePermission('masters:delete'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  await assertOwnedByCompany('makingCharge', req.params.id, companyId, 'Making charge entry');
  await tenantQuery(companyId, (tx) => tx.makingCharge.update({ where: { id: req.params.id }, data: { isActive: false } }));
  res.json({ success: true, message: 'Making charge entry deactivated' });
});
