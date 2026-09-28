// One-off backfill for Phase J4's new permission strings, for companies provisioned BEFORE this
// change shipped. Starter Package v1 is immutable (see starterPackage/v1.ts's header) — editing it
// only changes what a NEW company gets from provisionCompany(); it never reaches an
// already-provisioned company's own Role rows. This mirrors the same gap already documented and
// left deliberately unapplied for the masters:view (Phase F) and client:*/payment:*/return:* (J2)
// permission additions — see CLAUDE.md.
//
// What it does, per company, additive-only (never removes or overwrites an existing grant, so a
// company that customised a role via the Role Editor keeps its customisation):
//   PRODUCTION_MANAGER  += po:approve, po:approve_high_value, grn:view
//   ACCOUNTANT          += report:financial_view, payment:view
//   SALES_MANAGER       += payment:view
//   STORE_MANAGER       += grn:view
// A role already holding '*' (SUPER_ADMIN) is skipped — it already has everything. A role that no
// longer carries the matching name (renamed by the company) is left alone; grant the permission by
// hand via the Role Editor instead.
//
// Usage:
//   npx ts-node scripts/backfillJ4Permissions.ts            (dry run — prints what WOULD change)
//   npx ts-node scripts/backfillJ4Permissions.ts --apply    (writes the changes)
import { config } from 'dotenv';
config();
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const GRANTS: Record<string, string[]> = {
  PRODUCTION_MANAGER: ['po:approve', 'po:approve_high_value', 'grn:view'],
  ACCOUNTANT: ['report:financial_view', 'payment:view'],
  SALES_MANAGER: ['payment:view'],
  STORE_MANAGER: ['grn:view'],
};

async function main() {
  const apply = process.argv.includes('--apply');
  const roles = await prisma.role.findMany({
    where: { name: { in: Object.keys(GRANTS) } },
    select: { id: true, companyId: true, name: true, permissions: true },
  });

  let changed = 0;
  for (const role of roles) {
    if (role.permissions.includes('*')) continue; // already has everything
    const toAdd = GRANTS[role.name].filter((p) => !role.permissions.includes(p));
    if (toAdd.length === 0) continue;

    changed++;
    const next = [...role.permissions, ...toAdd];
    console.log(`${apply ? 'UPDATING' : '[dry run] would update'} company=${role.companyId} role=${role.name}: +${toAdd.join(', ')}`);
    if (apply) {
      await prisma.role.update({ where: { id: role.id }, data: { permissions: next } });
    }
  }

  console.log(`\n${changed} role(s) ${apply ? 'updated' : 'would be updated'} out of ${roles.length} matching role rows across all companies.`);
  if (!apply) console.log('Re-run with --apply to write these changes.');
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
