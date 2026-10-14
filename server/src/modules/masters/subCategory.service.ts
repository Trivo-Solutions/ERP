import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error';
import { assertOwnedByCompany, assertOwnedIfPresent } from '../../middleware/tenant';
import { tenantQuery, tenantTransaction } from '../../shared/tenantContext';
import { subCategoryNameKey } from '../../shared/subCategory';
import { createAuditEntry } from '../../middleware/audit';

// Shared sub-categories: ONE row per company per logical sub-category, linked to categories through
// CategorySubCategory. Every function is pinned to companyId, and every id a request supplies
// (sub-category, category) is ownership-checked first — a wrong-company id is a 404.

const CATEGORY_REF = { select: { id: true, code: true, name: true } } as const;
const LINKS_INCLUDE = { categoryLinks: { include: { category: CATEGORY_REF } } } as const;

type SubWithLinks = Prisma.SubCategoryGetPayload<{ include: typeof LINKS_INCLUDE }>;

// The shape the screens use: the sub-category plus the categories it is linked to.
function present(s: SubWithLinks) {
  const { categoryLinks, ...rest } = s;
  return { ...rest, categories: categoryLinks.map((l) => l.category).sort((a, b) => a.name.localeCompare(b.name)) };
}

function cleanCodeAndName(body: { code?: unknown; name?: unknown }, required: boolean) {
  const out: { code?: string; name?: string } = {};
  if (body.code !== undefined || required) {
    if (typeof body.code !== 'string' || !body.code.trim()) throw new AppError('Sub-category code is required', 400);
    out.code = body.code.trim().toUpperCase();
  }
  if (body.name !== undefined || required) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw new AppError('Sub-category name is required', 400);
    out.name = body.name.trim().replace(/\s+/g, ' ');
  }
  return out;
}

// Duplicate = same code, or same name ignoring case/whitespace, within this company (excluding `exceptId`).
async function assertNoDuplicate(tx: Prisma.TransactionClient, companyId: string, code: string | undefined, name: string | undefined, exceptId?: string) {
  const all = await tx.subCategory.findMany({ where: { companyId, ...(exceptId && { id: { not: exceptId } }) }, select: { id: true, code: true, name: true } });
  const hit = all.find((s) => (code !== undefined && s.code === code) || (name !== undefined && subCategoryNameKey(s.name) === subCategoryNameKey(name)));
  if (hit) {
    throw new AppError(`Sub-category "${hit.name}" (${hit.code}) already exists — link the existing one to the category instead of creating it again`, 409);
  }
}

function conflictToAppError(err: unknown): never {
  // Two requests racing past the duplicate check: the unique index is the real guard.
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new AppError('That sub-category (or link) already exists', 409);
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError && /23505|unique/i.test(err.message)) {
    throw new AppError('That sub-category (or link) already exists', 409);
  }
  throw err;
}

export async function listSubCategories(companyId: string, opts: { categoryId?: string; search?: string; activeOnly?: boolean }) {
  if (opts.categoryId) await assertOwnedByCompany('productCategory', opts.categoryId, companyId, 'Category');
  const rows = await tenantQuery(companyId, (tx) => tx.subCategory.findMany({
    where: {
      companyId,
      ...(opts.activeOnly && { isActive: true }),
      ...(opts.categoryId && { categoryLinks: { some: { companyId, categoryId: opts.categoryId } } }),
    },
    include: LINKS_INCLUDE,
    orderBy: { name: 'asc' },
  }));
  const q = opts.search?.trim().toLowerCase();
  const shown = q ? rows.filter((s) => `${s.code} ${s.name}`.toLowerCase().includes(q)) : rows;
  return shown.map(present);
}

export async function listCategoriesForSubCategory(companyId: string, subCategoryId: string) {
  await assertOwnedByCompany('subCategory', subCategoryId, companyId, 'Sub-category');
  const links = await tenantQuery(companyId, (tx) => tx.categorySubCategory.findMany({
    where: { companyId, subCategoryId }, include: { category: CATEGORY_REF }, orderBy: { category: { name: 'asc' } },
  }));
  return links.map((l) => l.category);
}

/** Creates a NEW sub-category (and links it to `categoryId` when given). Never creates a duplicate. */
export async function createSubCategory(companyId: string, body: { code?: unknown; name?: unknown; categoryId?: unknown }, userId: string) {
  const { code, name } = cleanCodeAndName(body, true);
  const categoryId = body.categoryId == null || body.categoryId === '' ? undefined : (body.categoryId as string);
  await assertOwnedIfPresent('productCategory', categoryId, companyId, 'Category');
  try {
    const created = await tenantTransaction(companyId, async (tx) => {
      await assertNoDuplicate(tx, companyId, code, name);
      const sub = await tx.subCategory.create({ data: { companyId, code: code!, name: name! } });
      if (categoryId) await tx.categorySubCategory.create({ data: { companyId, categoryId, subCategoryId: sub.id } });
      return tx.subCategory.findUniqueOrThrow({ where: { id: sub.id }, include: LINKS_INCLUDE });
    });
    await createAuditEntry('sub_categories', created.id, userId, 'CREATE', undefined,
      { code: created.code, name: created.name, linkedCategoryId: categoryId ?? null }, companyId);
    return present(created);
  } catch (err) { conflictToAppError(err); }
}

/** Rename / change code / activate-deactivate. Renaming changes the ONE shared master everywhere. */
export async function updateSubCategory(companyId: string, id: string, body: { code?: unknown; name?: unknown; isActive?: unknown; reason?: unknown }, userId: string) {
  await assertOwnedByCompany('subCategory', id, companyId, 'Sub-category');
  const before = await tenantQuery(companyId, (tx) => tx.subCategory.findFirstOrThrow({ where: { id, companyId }, select: { code: true, name: true, isActive: true } }));
  const data: { code?: string; name?: string; isActive?: boolean } = cleanCodeAndName(body, false);
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') throw new AppError('isActive must be true or false', 400);
    data.isActive = body.isActive;
  }
  try {
    const updated = await tenantTransaction(companyId, async (tx) => {
      if (data.code !== undefined || data.name !== undefined) await assertNoDuplicate(tx, companyId, data.code, data.name, id);
      return tx.subCategory.update({ where: { id }, data, include: LINKS_INCLUDE });
    });
    // Renaming / re-coding / deactivating changes the ONE shared master, so it changes what every tag that carries
    // it prints and reports from now on (labels and lists read the master live). The tag rows themselves are
    // untouched — their legacy stored `name` text is never rewritten — so the audit records how many tags move.
    const changed = (['code', 'name', 'isActive'] as const).filter((k) => data[k] !== undefined && data[k] !== before[k]);
    if (changed.length) {
      const affectedTags = await tenantQuery(companyId, (tx) => tx.jewelryTag.count({ where: { companyId, subCategoryId: id } }));
      const action = changed.includes('name') || changed.includes('code') ? 'RENAME'
        : data.isActive === false ? 'DEACTIVATE' : 'REACTIVATE';
      const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
      await createAuditEntry('sub_categories', id, userId, action,
        { code: before.code, name: before.name, isActive: before.isActive },
        { code: updated.code, name: updated.name, isActive: updated.isActive, changed, affectedTags, reason }, companyId);
    }
    return present(updated);
  } catch (err) { conflictToAppError(err); }
}

/** Links an EXISTING sub-category to another category. */
export async function linkSubCategory(companyId: string, subCategoryId: string, categoryId: unknown, userId: string) {
  await assertOwnedByCompany('subCategory', subCategoryId, companyId, 'Sub-category');
  await assertOwnedByCompany('productCategory', categoryId as string, companyId, 'Category');
  let linkId = '';
  try {
    await tenantTransaction(companyId, async (tx) => {
      const already = await tx.categorySubCategory.findFirst({ where: { companyId, categoryId: categoryId as string, subCategoryId } });
      if (already) throw new AppError('This sub-category is already linked to that category', 409);
      const link = await tx.categorySubCategory.create({ data: { companyId, categoryId: categoryId as string, subCategoryId } });
      linkId = link.id;
    });
    await createAuditEntry('category_sub_categories', linkId, userId, 'LINK', undefined, { categoryId, subCategoryId }, companyId);
  } catch (err) { conflictToAppError(err); }
  return listCategoriesForSubCategory(companyId, subCategoryId);
}

/** Removes one link. Refused while any tag in that category still carries the sub-category. */
export async function unlinkSubCategory(companyId: string, subCategoryId: string, categoryId: string, userId: string) {
  await assertOwnedByCompany('subCategory', subCategoryId, companyId, 'Sub-category');
  await assertOwnedByCompany('productCategory', categoryId, companyId, 'Category');
  let removedLinkId = '';
  await tenantTransaction(companyId, async (tx) => {
    const link = await tx.categorySubCategory.findFirst({ where: { companyId, categoryId, subCategoryId } });
    if (!link) throw new AppError('That sub-category is not linked to that category', 404);
    const used = await tx.jewelryTag.count({ where: { companyId, categoryId, subCategoryId } });
    if (used > 0) {
      throw new AppError(`Cannot unlink: ${used} tag${used === 1 ? '' : 's'} in this category use this sub-category. Deactivate the sub-category instead.`, 409);
    }
    await tx.categorySubCategory.delete({ where: { id: link.id } });
    removedLinkId = link.id;
  });
  await createAuditEntry('category_sub_categories', removedLinkId, userId, 'UNLINK', { categoryId, subCategoryId }, undefined, companyId);
  return listCategoriesForSubCategory(companyId, subCategoryId);
}

/** Hard delete — only a sub-category no tag has ever used (its links go with it). Otherwise deactivate. */
export async function deleteSubCategory(companyId: string, id: string, userId: string) {
  await assertOwnedByCompany('subCategory', id, companyId, 'Sub-category');
  const before = await tenantQuery(companyId, (tx) => tx.subCategory.findFirstOrThrow({ where: { id, companyId }, select: { code: true, name: true } }));
  await tenantTransaction(companyId, async (tx) => {
    const used = await tx.jewelryTag.count({ where: { companyId, subCategoryId: id } });
    if (used > 0) throw new AppError('This sub-category is in use and cannot be deleted. Deactivate it instead.', 409);
    await tx.categorySubCategory.deleteMany({ where: { companyId, subCategoryId: id } });
    await tx.subCategory.delete({ where: { id } });
  });
  await createAuditEntry('sub_categories', id, userId, 'DELETE', before, undefined, companyId);
}
