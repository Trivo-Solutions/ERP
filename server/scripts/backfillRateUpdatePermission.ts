// One-off backfill for the new `rate:update` permission (entering / changing the daily gold & silver rates), for companies
// provisioned BEFORE it existed. Starter Package v1 only reaches a company provisioned from now on; it never touches an
// already-provisioned company's own Role rows (same gap as the J2 / J4 permission additions).
//
// Who gets it - and ONLY them: every role that currently holds `system:config`. Until now `system:config` was what
// `POST /designs/rates` required, so those roles could already enter the daily rate; this keeps exactly that group able to,
// and grants nothing to anyone else. Additive only (never removes or rewrites a grant), so a customised role keeps its
// customisation. A role that already holds '*' (SUPER_ADMIN) is skipped - it has everything. Roles without `system:config`
// stay as they are; give `rate:update` to those by hand in the Role Editor if the company wants them to enter rates.
//
// Usage (DRY RUN by default - prints what would change, writes nothing):
//   npx ts-node scripts/backfillRateUpdatePermission.ts
//   npx ts-node scripts/backfillRateUpdatePermission.ts --apply        (writes; each user must log in again to pick it up)
//
// Connects with PLATFORM_DATABASE_URL (the BYPASSRLS operator identity) when set - the runtime role cannot see roles across
// companies under row-level security - otherwise DATABASE_URL (single-role dev/test databases). Never prints the URL.
import { config } from 'dotenv';
config();
import { PrismaClient } from '@prisma/client';

const url = process.env.PLATFORM_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('Neither PLATFORM_DATABASE_URL nor DATABASE_URL is set.'); process.exit(2); }
const prisma = new PrismaClient({ datasources: { db: { url } } });

const NEW_PERMISSION = 'rate:update';
const SOURCE_PERMISSION = 'system:config';

export function needsGrant(permissions: string[]): boolean {
  return !permissions.includes('*') && permissions.includes(SOURCE_PERMISSION) && !permissions.includes(NEW_PERMISSION);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const roles = await prisma.role.findMany({
    where: { permissions: { has: SOURCE_PERMISSION } },
    select: { id: true, companyId: true, name: true, permissions: true },
    orderBy: [{ companyId: 'asc' }, { name: 'asc' }],
  });

  let changed = 0;
  for (const role of roles) {
    if (!needsGrant(role.permissions)) continue;
    changed++;
    console.log(`${apply ? 'UPDATING' : '[dry run] would update'} company=${role.companyId} role=${role.name}: +${NEW_PERMISSION}`);
    if (apply) {
      // Count-checked on the permission list we read, so a role edited in the meantime is not overwritten blind.
      const r = await prisma.role.updateMany({
        where: { id: role.id, companyId: role.companyId, NOT: { permissions: { has: NEW_PERMISSION } } },
        data: { permissions: [...role.permissions, NEW_PERMISSION] },
      });
      if (r.count !== 1) console.log(`  (skipped - ${role.name} changed or already has it)`);
    }
  }

  console.log(`\n${changed} role(s) ${apply ? 'updated' : 'would be updated'} out of ${roles.length} role(s) holding ${SOURCE_PERMISSION}.`);
  if (!apply) console.log('Re-run with --apply to write these changes.');
}

if (require.main === module) {
  main()
    .then(() => prisma.$disconnect())
    .catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
}
