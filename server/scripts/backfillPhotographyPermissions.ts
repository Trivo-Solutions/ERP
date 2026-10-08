// Backfill for the Photography permission strings (photography:view / capture / review / delete / restore /
// manage_stations / manage_cameras), for companies provisioned BEFORE they existed. Starter Package v1 is immutable,
// so nothing reaches an already-provisioned company's Role rows by itself (same gap as scripts/backfillJ4Permissions.ts).
//
// Which role gets which permission is NOT decided yet (open question in the Photography Phase 0 audit), so unlike the
// J4 script this one carries no built-in mapping: you pass it explicitly, one --grant per role.
//   --grant ROLE_NAME=perm1,perm2     (repeatable)
//
// Additive only: never removes or overwrites an existing grant; roles holding '*' are skipped; a role whose name
// no longer matches is left alone. Dry run by default.
//
// Usage:
//   npx ts-node scripts/backfillPhotographyPermissions.ts --grant STORE_MANAGER=photography:view,photography:capture
//   npx ts-node scripts/backfillPhotographyPermissions.ts --grant STORE_MANAGER=photography:view --apply
import { config } from 'dotenv';
config();
import { PrismaClient } from '@prisma/client';

const PHOTOGRAPHY_PERMISSIONS = new Set([
  'photography:view', 'photography:capture', 'photography:review', 'photography:delete',
  'photography:restore', 'photography:manage_stations', 'photography:manage_cameras', 'photography:manage_settings',
]);

function parseGrants(argv: string[]): Record<string, string[]> {
  const grants: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--grant') continue;
    const [role, list] = (argv[i + 1] ?? '').split('=');
    const perms = (list ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    if (!role || perms.length === 0) throw new Error(`Bad --grant '${argv[i + 1]}' (expected ROLE_NAME=perm1,perm2)`);
    for (const p of perms) if (!PHOTOGRAPHY_PERMISSIONS.has(p)) throw new Error(`Unknown photography permission '${p}'`);
    grants[role] = [...new Set([...(grants[role] ?? []), ...perms])];
  }
  return grants;
}

const prisma = new PrismaClient();

async function main() {
  const apply = process.argv.includes('--apply');
  const grants = parseGrants(process.argv.slice(2));
  if (Object.keys(grants).length === 0) throw new Error('Nothing to do: pass at least one --grant ROLE_NAME=perm1,perm2');

  const roles = await prisma.role.findMany({
    where: { name: { in: Object.keys(grants) } },
    select: { id: true, companyId: true, name: true, permissions: true },
  });

  let changed = 0;
  for (const role of roles) {
    if (role.permissions.includes('*')) continue;
    const toAdd = grants[role.name].filter((p) => !role.permissions.includes(p));
    if (toAdd.length === 0) continue;
    changed++;
    console.log(`${apply ? 'UPDATING' : '[dry run] would update'} company=${role.companyId} role=${role.name}: +${toAdd.join(', ')}`);
    if (apply) await prisma.role.update({ where: { id: role.id }, data: { permissions: [...role.permissions, ...toAdd] } });
  }

  console.log(`\n${changed} role(s) ${apply ? 'updated' : 'would be updated'} out of ${roles.length} matching role rows across all companies.`);
  if (!apply) console.log('Re-run with --apply to write these changes.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e instanceof Error ? e.message : e); await prisma.$disconnect(); process.exit(1); });
