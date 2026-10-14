import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { assertOwnedByCompany } from '../../middleware/tenant';
import { TenantContext, tenantQuery, tenantTransaction } from '../../shared/tenantContext';
import { deriveTagName } from '../../shared/tagClassification';

// Approved correction of a tag's classification (sub-category within its own category).
//
// This is NOT a bulk "fix by name" tool. The business owner decides, tag by tag, which sub-category each piece
// really is; this service only carries that decision out, and only for the exact tag ids it is given:
//   1. previewTagReclassification — read-only dry run: before / after for every item and every refusal reason.
//   2. applyTagReclassification   — one transaction for the whole set (all or nothing), a mandatory reason and
//      reference, one immutable audit row per tag (before/after, reason, reference, batch id). The tag_history
//      trigger independently records the row change with the acting user.
// It changes subCategoryId (and the legacy stored `name` so it follows) — never costPrice, status, branch, weights.
// Status is NOT a barrier on purpose: a sold piece mis-classified at tagging is exactly what needs correcting, and
// the correction touches only what the label / reports call it, never stock or money.

export const MAX_RECLASSIFY_BATCH = 200;

export interface ReclassifyItem { tagId: string; subCategoryId: string; categoryId?: string }
export interface ReclassifyRow {
  tagId: string; tagNumber: string | null; status: string | null;
  before: { categoryId: string | null; category: string | null; subCategoryId: string | null; subCategory: string | null; subCategoryCode: string | null; name: string | null } | null;
  after: { categoryId: string; category: string; subCategoryId: string; subCategory: string; subCategoryCode: string; name: string } | null;
  willChange: boolean;
  refusal: string | null;
}

function cleanItems(items: unknown): ReclassifyItem[] {
  if (!Array.isArray(items) || items.length === 0) throw new AppError('Provide the exact tags to correct (items[])', 400);
  if (items.length > MAX_RECLASSIFY_BATCH) throw new AppError(`At most ${MAX_RECLASSIFY_BATCH} tags per correction`, 400);
  const seen = new Set<string>();
  return items.map((i: any) => {
    if (!i || typeof i.tagId !== 'string' || typeof i.subCategoryId !== 'string' || !i.tagId || !i.subCategoryId) {
      throw new AppError('Every item needs a tagId and the subCategoryId the owner confirmed', 400);
    }
    if (i.categoryId !== undefined && typeof i.categoryId !== 'string') throw new AppError('categoryId must be a string', 400);
    if (seen.has(i.tagId)) throw new AppError(`Tag ${i.tagId} is listed twice`, 400);
    seen.add(i.tagId);
    return { tagId: i.tagId, subCategoryId: i.subCategoryId, categoryId: i.categoryId };
  });
}

/** Read-only. Every refusal is reported per row; nothing is written. */
export async function previewTagReclassification(ctx: TenantContext, rawItems: unknown): Promise<{ rows: ReclassifyRow[]; changeCount: number; refusedCount: number }> {
  const items = cleanItems(rawItems);
  const rows: ReclassifyRow[] = [];
  for (const it of items) {
    const tag = await tenantQuery(ctx.companyId, (tx) => tx.jewelryTag.findFirst({
      where: { id: it.tagId, companyId: ctx.companyId },
      select: {
        id: true, tagNumber: true, status: true, name: true, categoryId: true, subCategoryId: true, branchId: true,
        category: { select: { name: true } }, subCategory: { select: { name: true, code: true } },
      },
    }));
    if (!tag) { rows.push({ tagId: it.tagId, tagNumber: null, status: null, before: null, after: null, willChange: false, refusal: 'Tag not found' }); continue; }
    const before = {
      categoryId: tag.categoryId, category: tag.category?.name ?? null,
      subCategoryId: tag.subCategoryId, subCategory: tag.subCategory?.name ?? null, subCategoryCode: tag.subCategory?.code ?? null, name: tag.name,
    };
    const base = { tagId: tag.id, tagNumber: tag.tagNumber, status: tag.status, before };
    const categoryId = tag.categoryId;
    if (!categoryId) { rows.push({ ...base, after: null, willChange: false, refusal: 'The tag has no category' }); continue; }
    if (it.categoryId && it.categoryId !== categoryId) {
      rows.push({ ...base, after: null, willChange: false, refusal: 'Changing the category itself is not part of this correction (it is built into the tag number)' });
      continue;
    }
    const link = await tenantQuery(ctx.companyId, (tx) => tx.categorySubCategory.findFirst({
      where: { companyId: ctx.companyId, categoryId, subCategoryId: it.subCategoryId },
      include: { subCategory: { select: { id: true, name: true, code: true, isActive: true } }, category: { select: { name: true } } },
    }));
    if (!link) { rows.push({ ...base, after: null, willChange: false, refusal: "That sub-category is not linked to this tag's category (or does not exist)" }); continue; }
    if (!link.subCategory.isActive) { rows.push({ ...base, after: null, willChange: false, refusal: `Sub-category "${link.subCategory.name}" is inactive` }); continue; }
    const after = {
      categoryId, category: link.category.name, subCategoryId: link.subCategory.id,
      subCategory: link.subCategory.name, subCategoryCode: link.subCategory.code,
      name: deriveTagName({ name: link.category.name }, link.subCategory, tag.name),
    };
    rows.push({ ...base, after, willChange: tag.subCategoryId !== it.subCategoryId, refusal: null });
  }
  return { rows, changeCount: rows.filter((r) => r.willChange).length, refusedCount: rows.filter((r) => r.refusal).length };
}

/**
 * Applies exactly the previewed set. Refuses the WHOLE batch if any row is refused, so a partial correction never
 * has to be reasoned about. Rows already at the target are left alone (idempotent re-run).
 */
export async function applyTagReclassification(
  ctx: TenantContext, userId: string,
  body: { items?: unknown; reason?: unknown; reference?: unknown; confirm?: unknown },
) {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
  if (reason.length < 5) throw new AppError('A reason is required for a classification correction', 400);
  if (!reference) throw new AppError('A reference (who approved it / the approval note) is required', 400);
  if (body.confirm !== true) throw new AppError('Explicit confirmation is required (confirm: true)', 400);

  const items = cleanItems(body.items);
  for (const it of items) await assertOwnedByCompany('jewelryTag', it.tagId, ctx.companyId, 'Tag');
  const preview = await previewTagReclassification(ctx, items);
  const refused = preview.rows.filter((r) => r.refusal);
  if (refused.length) {
    throw new AppError(`${refused.length} tag(s) cannot be corrected: ${refused.slice(0, 5).map((r) => `${r.tagNumber ?? r.tagId} — ${r.refusal}`).join('; ')}`, 409);
  }
  const todo = preview.rows.filter((r) => r.willChange);
  const batchId = `RECLASS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  await tenantTransaction(ctx.companyId, async (tx) => {
    for (const r of todo) {
      // Count-checked: the tag must still carry the sub-category that was previewed, else it changed meanwhile.
      const res = await tx.jewelryTag.updateMany({
        where: { id: r.tagId, companyId: ctx.companyId, subCategoryId: r.before!.subCategoryId },
        data: { subCategoryId: r.after!.subCategoryId, name: r.after!.name },
      });
      if (res.count !== 1) throw new AppError(`Tag ${r.tagNumber} changed while the correction was running; nothing was applied — preview again`, 409);
    }
  });
  // Audit rows follow the committed data change (createAuditEntry is its own company-scoped write).
  for (const r of todo) {
    await createAuditEntry('jewelry_tags', r.tagId, userId, 'CLASSIFICATION_CORRECTION',
      { ...r.before },
      { ...r.after, reason, reference, batchId, administrativeCorrection: true }, ctx.companyId);
  }
  return { batchId, applied: todo.length, unchanged: preview.rows.length - todo.length, rows: preview.rows };
}
