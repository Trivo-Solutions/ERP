import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { tenantTransaction } from './tenantContext';
import { STARTER_PACKAGE_V1 } from '../modules/platform/starterPackage';

// The karat list and design categories every company begins with. The values are defined ONCE, in
// the versioned TRIVO Starter Package (modules/platform/starterPackage/v1.ts); this file only
// exposes the two lists for callers that want just them (test fixtures, the seed). Full company
// provisioning applies the whole package via applyStarterPackage().
//
// Each company gets its own independent COPY (its own rows, its own ids) — never a reference to a
// shared row — so editing "Rings" in one company can never change another's.

export const STARTER_KARATS = STARTER_PACKAGE_V1.masters.karats;
export const STARTER_DESIGN_CATEGORIES = STARTER_PACKAGE_V1.masters.designCategories;

/**
 * Idempotent (upsert on companyId + code) — safe to re-run, and never overwrites a value the
 * company has since edited (update is a no-op).
 */
export async function seedStarterMasters(
  companyId: string,
  client?: Prisma.TransactionClient | typeof prisma
): Promise<void> {
  if (!client) return tenantTransaction(companyId, (tx) => seedStarterMasters(companyId, tx));
  for (const k of STARTER_KARATS) {
    await client.karatMaster.upsert({
      where: { companyId_code: { companyId, code: k.code } },
      update: {},
      create: { companyId, ...k },
    });
  }
  for (const c of STARTER_DESIGN_CATEGORIES) {
    await client.designCategory.upsert({
      where: { companyId_code: { companyId, code: c.code } },
      update: {},
      create: { companyId, ...c },
    });
  }
}
