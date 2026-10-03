import { AppError } from '../middleware/error';
import { assertOwnedIfPresent } from '../middleware/tenant';
import { tenantQuery } from './tenantContext';

// A sub-category is one company-owned master linked to many categories (CategorySubCategory). A tag's
// (categoryId, subCategoryId) must be one of those links — the server is the authority; the pickers
// on the screens only mirror it.

/** Name identity: same words ignoring case and surrounding/repeated whitespace. */
export const subCategoryNameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Validates the sub-category a tag is about to carry. Ownership first (another company's id is a 404),
 * then the category link (400), then — only when `requireActive` — that the master is still active.
 * Pass requireActive=false for a tag edit that keeps its existing sub-category, so a later
 * deactivation of the master never blocks editing a tag that already carries it.
 */
export async function assertSubCategoryForCategory(
  companyId: string,
  categoryId: string | null | undefined,
  subCategoryId: string | null | undefined,
  requireActive: boolean,
): Promise<void> {
  if (!subCategoryId) return;
  await assertOwnedIfPresent('subCategory', subCategoryId, companyId, 'Sub-category');
  if (!categoryId) throw new AppError('Choose a category before a sub-category', 400);
  const link = await tenantQuery(companyId, (tx) => tx.categorySubCategory.findFirst({
    where: { companyId, categoryId, subCategoryId },
    include: { subCategory: { select: { name: true, isActive: true } } },
  }));
  if (!link) throw new AppError('This sub-category is not linked to the selected category', 400);
  if (requireActive && !link.subCategory.isActive) {
    throw new AppError(`Sub-category "${link.subCategory.name}" is inactive`, 400);
  }
}
