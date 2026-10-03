import type { Prisma } from '@prisma/client';
import type { StarterPackageDefinition } from './types';
import { validateStarterPackage } from './validate';

export interface StarterApplyCounts {
  roles: number; accounts: number; karats: number; designCategories: number; productCategories: number;
  subCategories: number; collections: number; materialCodes: number; stockTypes: number;
  stoneTypes: number; stoneGrades: number; tagTemplates: number; estimateTemplates: number; config: number;
}

/**
 * COPIES a Starter Package into one company. Every row created here is brand new, owned by
 * `companyId`, with its own id — nothing is referenced from, or shared with, any other company or
 * with the package itself. The package is a read-only definition; this function only reads it.
 *
 * Must be called inside the provisioning transaction (`tx`) with the tenant session already set.
 * It is for a brand-new company only: it uses plain creates (not upserts), so applying it to a
 * company that already has these rows fails on the per-company unique constraints instead of
 * silently overwriting anything — an existing company is never modified by a package.
 */
export async function applyStarterPackage(
  tx: Prisma.TransactionClient,
  companyId: string,
  pkg: StarterPackageDefinition,
) {
  validateStarterPackage(pkg); // defence in depth — packages are validated at registration too
  const m = pkg.masters;

  await tx.role.createMany({
    data: pkg.roles.map((r) => ({ companyId, name: r.name, displayName: r.displayName, permissions: r.permissions })),
  });
  const roles = await tx.role.findMany({ where: { companyId } });

  await tx.account.createMany({
    data: pkg.chartOfAccounts.map((a) => ({ companyId, code: a.code, name: a.name, type: a.type, subType: a.subType, isSystem: a.isSystem })),
  });

  await tx.karatMaster.createMany({ data: m.karats.map((k) => ({ companyId, ...k })) });
  await tx.designCategory.createMany({ data: m.designCategories.map((c) => ({ companyId, ...c })) });

  await tx.productCategory.createMany({ data: m.productCategories.map((c) => ({ companyId, ...c })) });
  const categories = await tx.productCategory.findMany({ where: { companyId }, select: { id: true, code: true } });
  const categoryIdByCode = new Map(categories.map((c) => [c.code, c.id]));
  // A starter sub-category is one shared master row; the package lists each with its (single) category,
  // which becomes one CategorySubCategory link. The company can link more categories later.
  await tx.subCategory.createMany({ data: m.subCategories.map((s) => ({ companyId, code: s.code, name: s.name })) });
  const subs = await tx.subCategory.findMany({ where: { companyId }, select: { id: true, code: true } });
  const subIdByCode = new Map(subs.map((s) => [s.code, s.id]));
  await tx.categorySubCategory.createMany({
    data: m.subCategories.map((s) => ({
      companyId, categoryId: categoryIdByCode.get(s.categoryCode)!, subCategoryId: subIdByCode.get(s.code)!,
    })),
  });

  await tx.collection.createMany({ data: m.collections.map((c) => ({ companyId, ...c })) });
  await tx.materialCode.createMany({ data: m.materialCodes.map((c) => ({ companyId, ...c })) });
  await tx.stockType.createMany({ data: m.stockTypes.map((c) => ({ companyId, ...c })) });

  await tx.stoneType.createMany({ data: m.stoneTypes.map((c) => ({ companyId, ...c })) });
  const stoneTypes = await tx.stoneType.findMany({ where: { companyId }, select: { id: true, code: true } });
  const stoneTypeIdByCode = new Map(stoneTypes.map((s) => [s.code, s.id]));
  await tx.stoneGrade.createMany({
    data: m.stoneGrades.map(({ stoneTypeCode, ...g }) => ({ companyId, stoneTypeId: stoneTypeIdByCode.get(stoneTypeCode)!, ...g })),
  });

  await tx.tagTemplate.createMany({
    data: pkg.templates.tag.map((t) => ({ companyId, name: t.name, isDefault: t.isDefault, widthMm: t.widthMm, heightMm: t.heightMm, gapMm: t.gapMm, layout: t.layout as Prisma.InputJsonValue })),
  });
  await tx.estimateTemplate.createMany({
    data: pkg.templates.estimate.map((t) => ({ companyId, name: t.name, isDefault: t.isDefault, widthMm: t.widthMm, heightMm: t.heightMm, layout: t.layout as Prisma.InputJsonValue })),
  });

  await tx.systemConfig.createMany({ data: pkg.config.map((c) => ({ companyId, ...c })) });

  const counts: StarterApplyCounts = {
    roles: pkg.roles.length, accounts: pkg.chartOfAccounts.length, karats: m.karats.length,
    designCategories: m.designCategories.length, productCategories: m.productCategories.length,
    subCategories: m.subCategories.length, collections: m.collections.length, materialCodes: m.materialCodes.length,
    stockTypes: m.stockTypes.length, stoneTypes: m.stoneTypes.length, stoneGrades: m.stoneGrades.length,
    tagTemplates: pkg.templates.tag.length, estimateTemplates: pkg.templates.estimate.length, config: pkg.config.length,
  };
  return { roles, counts };
}
