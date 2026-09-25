// Operator CLI: provision a new TRIVO company (same provisionCompany() the platform API uses).
//
//   npm run company:provision --workspace=server -- --code VASAVI --name "Vasavi Gold & Diamonds" \
//        --admin-email owner@vasavi.example --admin-name "Vasavi Owner" [--admin-password <12+ chars>] \
//        [--gstin ...] [--state-code 24] [--address "..."] [--starter-version 1]
//
// If --admin-password is omitted a random one is generated and printed ONCE. If the admin e-mail
// already has a login, no password is set: a pending SUPER_ADMIN invitation token is printed instead.
import { provisionCompany } from '../src/modules/platform/provisioning.service';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const code = arg('code'); const name = arg('name');
  const email = arg('admin-email'); const adminName = arg('admin-name');
  if (!code || !name || !email || !adminName) {
    console.error('Required: --code --name --admin-email --admin-name');
    process.exit(2);
  }
  const result = await provisionCompany({
    code, name,
    gstin: arg('gstin') ?? null, stateCode: arg('state-code') ?? null, address: arg('address') ?? null,
    admin: { email, name: adminName, password: arg('admin-password') },
    starterPackageVersion: arg('starter-version') ? Number(arg('starter-version')) : undefined,
    actor: { label: 'cli' },
  });
  console.log(JSON.stringify(result, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message ?? e); process.exit(1); });
