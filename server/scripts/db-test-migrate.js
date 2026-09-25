// Applies pending migrations to the dedicated test database only. Guarded so this can
// never accidentally run against the dev/prod DATABASE_URL from .env.
const path = require('path');
const dotenv = require('dotenv');
const { spawnSync } = require('child_process');

dotenv.config({ path: path.resolve(__dirname, '../.env.test'), override: true });

const url = process.env.DATABASE_URL || '';
if (!url.includes('sea_erp_test')) {
  console.error(`Refusing to run: DATABASE_URL does not point at sea_erp_test.\nGot: ${url}`);
  process.exit(1);
}

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: process.env,
  shell: true,
});
process.exit(result.status ?? 1);
