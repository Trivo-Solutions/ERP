// Runs the whole test suite against a database with the REAL role split, as the application would run in
// production: DATABASE_URL = trivo_runtime (RLS enforced), PLATFORM_DATABASE_URL = trivo_platform.
//
//   TRIVO_TEST_ENV_FILE=<path to env file>  npm run test:rls [-- <vitest args>]
//
// See prisma/production-rls-roles.sql (bootstrap) and prisma/db-secure.sql (grants + FORCE) for how such a
// database is prepared; docs in CLAUDE.md §11.
const { spawnSync } = require('child_process');
const fs = require('fs');
const envFile = process.env.TRIVO_TEST_ENV_FILE || 'C:/trivo-staging/rlstest.env';
if (!fs.existsSync(envFile)) {
  console.error(`RLS test env file not found: ${envFile}\nSet TRIVO_TEST_ENV_FILE (see scripts/test-rls.js).`);
  process.exit(2);
}
const args = ['vitest', 'run', 'src', ...process.argv.slice(2)];
const r = spawnSync('npx', args, { stdio: 'inherit', shell: true, env: { ...process.env, TRIVO_TEST_ENV_FILE: envFile } });
process.exit(r.status ?? 1);
