import path from 'path';
import dotenv from 'dotenv';

// Load the dedicated test database URL(s) BEFORE any test file imports config/database.ts
// (which constructs PrismaClient at module-load time using process.env.DATABASE_URL).
//
// Two modes:
//   default                 .env.test — a single all-powerful role on `sea_erp_test`. Row-level security is
//                           inert there (the role owns the tables); this is the fast everyday run.
//   TRIVO_TEST_ENV_FILE=…   an env file for a cluster with the REAL role split (`npm run test:rls`):
//                           DATABASE_URL = trivo_runtime (RLS enforced, tables FORCEd),
//                           PLATFORM_DATABASE_URL = trivo_platform (BYPASSRLS, for fixtures/verification).
//                           The whole suite then runs as the production application would.
const rlsEnvFile = process.env.TRIVO_TEST_ENV_FILE;
dotenv.config({ path: rlsEnvFile ?? path.resolve(__dirname, '../.env.test'), override: true });

// Hard guard: never let a test run land on the real dev/prod database, no matter what
// the environment happens to have set.
const url = process.env.DATABASE_URL ?? '';
const allowed = rlsEnvFile ? 'trivo_rlstest' : 'sea_erp_test';
if (!url.includes(allowed)) {
  throw new Error(
    `Refusing to run tests: DATABASE_URL does not point at the test database (${allowed}).\n` +
    `Got: ${url.replace(/:[^:@/]+@/, ':***@')}\nCheck ${rlsEnvFile ?? 'server/.env.test'}.`
  );
}
if (rlsEnvFile && !(process.env.PLATFORM_DATABASE_URL ?? '').includes('trivo_rlstest')) {
  throw new Error('RLS test mode requires PLATFORM_DATABASE_URL to point at trivo_rlstest as the platform role.');
}
